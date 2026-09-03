import { SpanKind } from '@opentelemetry/api';
import { eq, sql } from 'drizzle-orm';
import {
	auditEvent,
	eventDelivery,
	eventEndpoint,
	type DeliveryErrorReason,
	type EgressFormat
} from '../db/schema';
import { withSpan } from '../telemetry';
import { backoffMinutes, MAX_ATTEMPTS, postEvent } from './client';
import { validateEndpointUrl, type AllowEntry, type LookupAll } from './destination';
import { enrichEvent } from './enrich';
import { formatEvent } from './format';
import { endpointSecret, signatureHeader } from './secret';
import type { Db } from '../db';

/** Global per tick, subdivided by the per-endpoint cap below. */
export const CLAIM_LIMIT = 25;
/**
 * Deliveries are round-robin across endpoints rather than draining one
 * endpoint at a time: without this a single black-holing endpoint delays every
 * other endpoint's deliveries by the full tick, and the 15 s interval exists
 * because a late notice is a defect (spec §5.1). Stating which limit is which
 * matters — per-endpoint alone multiplies tick time by the endpoint count,
 * global alone starves by claim order.
 */
export const PER_ENDPOINT_LIMIT = 5;

export interface ClaimedDelivery {
	id: string;
	endpointId: string;
	auditSeq: bigint;
	auditId: string;
	attempts: number;
	endpoint: { url: string; format: EgressFormat; secretVersion: number };
}

export interface DeliverOptions {
	baseUrl: string;
	locale: string;
	signingKey: string | undefined;
	allow: readonly AllowEntry[];
	/** Test seam, as on `PostInput`. Never set on the delivery path. */
	lookup?: LookupAll;
}

/**
 * Phase one, under the advisory lock and inside one transaction: claim due
 * rows and push their next attempt forward, exactly as `drainOutbox` does. The
 * pushed-forward claim is what makes phase two safe with no lock held.
 */
export async function claimDeliveries(
	tx: Db,
	options: { limit?: number; perEndpoint?: number } = {}
): Promise<ClaimedDelivery[]> {
	const limit = options.limit ?? CLAIM_LIMIT;
	const perEndpoint = options.perEndpoint ?? PER_ENDPOINT_LIMIT;

	// Postgres refuses `FOR UPDATE` in the same SELECT as a window function
	// (CheckSelectLocking: "FOR UPDATE is not allowed with window functions"),
	// so ranking and locking are two queries rather than one CTE. The first
	// picks candidate ids under the per-endpoint and global caps with no lock;
	// the window function is what makes the global limit fair, ranking rows
	// within their endpoint so the cap applies per endpoint and the outer LIMIT
	// then bounds total tick work.
	const candidates = (await tx.execute(sql`
		SELECT id FROM (
			SELECT d.id, d.next_attempt_at,
			       row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at, d.audit_seq) AS rank
			FROM event_delivery d
			JOIN event_endpoint e ON e.id = d.endpoint_id
			WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled = true
		) ranked
		WHERE rank <= ${perEndpoint}
		ORDER BY next_attempt_at
		LIMIT ${limit}
	`)) as unknown as { id: string }[];

	if (candidates.length === 0) return [];

	// The second query locks exactly those ids `FOR UPDATE SKIP LOCKED`,
	// re-checking the row's status and due-ness AND the endpoint's enabled
	// state, because time has passed since the unlocked read above and the two
	// statements take separate snapshots even inside one transaction. Without
	// re-checking `enabled` here, an operator disabling an endpoint in the
	// window between the two queries would still have a delivery claimed for
	// it — and then actually sent, moments later in phase two with no lock
	// held. Spec §5.5 is explicit that a disabled endpoint neither fans out
	// nor delivers; fan-out already enforces this (Task 9), so the delivery
	// half must too. A row a concurrent tick locked first is silently dropped
	// here rather than waited on — which only ever under-claims for this tick,
	// never double-claims.
	const rows = (await tx.execute(sql`
		SELECT d.id, d.endpoint_id, d.audit_seq, d.audit_id, d.attempts,
		       e.url, e.format, e.secret_version
		FROM event_delivery d
		JOIN event_endpoint e ON e.id = d.endpoint_id
		WHERE d.id = ANY(${sql.raw(`ARRAY['${candidates.map((row) => row.id).join("','")}']::uuid[]`)})
		  AND d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled = true
		ORDER BY d.next_attempt_at
		FOR UPDATE OF d SKIP LOCKED
	`)) as unknown as {
		id: string;
		endpoint_id: string;
		audit_seq: string;
		audit_id: string;
		attempts: number;
		url: string;
		format: EgressFormat;
		secret_version: number;
	}[];

	if (rows.length === 0) return [];

	// A crash mid-delivery retries later rather than being retried by the very
	// next tick.
	await tx.execute(sql`
		UPDATE event_delivery SET next_attempt_at = now() + interval '5 minutes'
		WHERE id = ANY(${sql.raw(`ARRAY['${rows.map((row) => row.id).join("','")}']::uuid[]`)})
	`);

	return rows.map((row) => ({
		id: row.id,
		endpointId: row.endpoint_id,
		auditSeq: BigInt(row.audit_seq),
		auditId: row.audit_id,
		attempts: Number(row.attempts),
		endpoint: { url: row.url, format: row.format, secretVersion: row.secret_version }
	}));
}

/**
 * Phase two, outside any transaction: render, POST, and record each outcome in
 * its own short write. Nothing here holds a lock, which is the point — see the
 * task note on why this cannot live inside `runJob`'s transaction.
 */
export async function deliverClaimed(
	db: Db,
	claimed: readonly ClaimedDelivery[],
	options: DeliverOptions
): Promise<{ delivered: number; failed: number; skipped: number }> {
	let delivered = 0;
	let failed = 0;
	let skipped = 0;

	for (const row of claimed) {
		// The Drizzle query builder, not raw SQL: a hand-written SELECT returns
		// snake_case keys, and enrichEvent reads camelCase (`actorType`,
		// `subjectType`, ...) — every field would silently be undefined rather
		// than throw, delivering an event with a null subject and empty data.
		const [audit] = await db
			.select()
			.from(auditEvent)
			.where(eq(auditEvent.seq, row.auditSeq))
			.limit(1);

		// The audit log is append-only, so the row cannot have been deleted — but
		// a delivery whose audit row is somehow absent has nothing to render.
		if (!audit) {
			await terminate(db, row, 'skipped', null, null);
			skipped++;
			continue;
		}

		const enriched = await enrichEvent(db, audit, {
			deliveryId: row.id,
			baseUrl: options.baseUrl,
			locale: options.locale
		});

		if (enriched.kind === 'skip') {
			// Nothing is sent. Blanks are the one shape a consumer cannot branch
			// on (spec §4.5).
			await terminate(db, row, 'skipped', null, null);
			skipped++;
			continue;
		}

		const { body, contentType } = formatEvent(row.endpoint.format, enriched.model);

		// Required for `generic` because that payload is what a consumer
		// authenticates. Teams verifies nothing, so a Teams-only operator should
		// not have to manage a key they cannot use (spec §7.1).
		if (row.endpoint.format === 'generic' && options.signingKey === undefined) {
			await recordFailure(db, row, null, 'signing_key_missing', false, null);
			failed++;
			continue;
		}

		const headers: Record<string, string> = {
			'x-trust-center-event': enriched.model.action,
			'x-trust-center-delivery': row.id
		};

		if (options.signingKey !== undefined) {
			const timestamp = Math.floor(Date.now() / 1000);
			const secrets = [
				endpointSecret(options.signingKey, row.endpointId, row.endpoint.secretVersion)
			];
			// The rotation overlap: the previous version travels alongside the
			// current one, without which a rotation makes every consumer return
			// 401 — which §5.3 makes terminal on the first attempt (spec §7.2).
			if (row.endpoint.secretVersion > 1) {
				secrets.push(
					endpointSecret(options.signingKey, row.endpointId, row.endpoint.secretVersion - 1)
				);
			}
			headers['x-trust-center-signature'] = signatureHeader(secrets, timestamp, body);
		}

		const outcome = await withSpan(
			'event deliver',
			{
				'egress.endpoint_id': row.endpointId,
				'egress.action': enriched.model.action,
				'egress.format': row.endpoint.format,
				'egress.attempt': row.attempts + 1
			},
			async (span) => {
				const result = await postEvent({
					// Re-validated here, not only on save: an endpoint row can be
					// changed by anyone with admin access between the two.
					url: validateEndpointUrl(row.endpoint.url, options.allow),
					allow: options.allow,
					body,
					contentType,
					headers,
					lookup: options.lookup
				});

				if (result.kind === 'delivered' || result.statusCode !== null) {
					span.setAttribute(
						'http.response.status_code',
						result.kind === 'delivered' ? result.statusCode : result.statusCode!
					);
				}
				return result;
			},
			// CLIENT, for the reason `mail send` is: Tempo, Jaeger, Grafana,
			// Datadog and the collector's spanmetrics connector all key service
			// maps and RED aggregation on the span kind.
			SpanKind.CLIENT
		);

		if (outcome.kind === 'delivered') {
			await db.transaction(async (tx) => {
				await tx
					.update(eventDelivery)
					.set({
						status: 'delivered',
						attempts: row.attempts + 1,
						lastStatusCode: outcome.statusCode,
						lastError: null,
						deliveredAt: new Date()
					})
					.where(eq(eventDelivery.id, row.id));
				// Drives auto-disable (spec §5.4). No audit event: the job mutates
				// the endpoint row routinely, and an event here would match the
				// endpoint's own filter and recur (spec §9).
				await tx
					.update(eventEndpoint)
					.set({ lastSuccessAt: new Date() })
					.where(eq(eventEndpoint.id, row.endpointId));
			});
			delivered++;
			continue;
		}

		await recordFailure(
			db,
			row,
			outcome.statusCode,
			outcome.reason,
			outcome.retryable,
			outcome.retryAfterSeconds
		);
		failed++;
	}

	return { delivered, failed, skipped };
}

async function terminate(
	db: Db,
	row: ClaimedDelivery,
	status: 'skipped',
	statusCode: number | null,
	reason: string | null
): Promise<void> {
	await db
		.update(eventDelivery)
		.set({ status, lastStatusCode: statusCode, lastError: reason })
		.where(eq(eventDelivery.id, row.id));
}

async function recordFailure(
	db: Db,
	row: ClaimedDelivery,
	statusCode: number | null,
	// The closed set, not `string`: a compile-time guarantee that nothing but
	// a fixed phrase can ever reach `last_error`, matching what the column
	// comment promises (spec §2.3, §6.4).
	reason: DeliveryErrorReason,
	retryable: boolean,
	retryAfterSeconds: number | null
): Promise<void> {
	const attempts = row.attempts + 1;
	const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
	// outbound_email's schedule verbatim, so the deployment has one retry story
	// rather than two that differ for no reason (spec §5.3).
	const delayMinutes = backoffMinutes(attempts);

	await db.execute(sql`
		UPDATE event_delivery
		SET status = ${giveUp ? 'failed' : 'pending'},
		    attempts = ${attempts},
		    last_status_code = ${statusCode},
		    last_error = ${reason},
		    next_attempt_at = ${
					retryAfterSeconds !== null
						? sql`now() + make_interval(secs => ${retryAfterSeconds})`
						: sql`now() + make_interval(mins => ${delayMinutes})`
				}
		WHERE id = ${row.id}::uuid
	`);
}
