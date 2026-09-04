import { SpanKind } from '@opentelemetry/api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordEvent } from '../audit';
import {
	auditEvent,
	eventDelivery,
	eventEndpoint,
	type DeliveryErrorReason,
	type EgressFormat
} from '../db/schema';
import { recordEgressDelivery, withSpan } from '../telemetry';
import { backoffMinutes, MAX_ATTEMPTS, postEvent } from './client';
import type { AllowEntry, LookupAll } from './destination';
import { enrichEvent, type EnrichOutcome } from './enrich';
import { formatEvent, requiresSigning } from './format';
import { eventHeaders } from './secret';
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

/**
 * Every row still owed a delivery, rows in retry backoff included — what is
 * queued, not what the next tick would claim. Lives here rather than at the
 * telemetry caller so the definition of "queued" stays beside the claim
 * predicate below, exactly as `pendingCount` sits beside `drainOutbox`'s.
 */
export async function pendingDeliveryCount(db: Db): Promise<number> {
	const [row] = await db
		.select({ depth: sql<number>`count(*)::int` })
		.from(eventDelivery)
		.where(eq(eventDelivery.status, 'pending'));

	return row?.depth ?? 0;
}

/**
 * The same depth, split per endpoint. Both callers — the backpressure check in
 * fan-out and the admin list page — read it for every endpoint at once rather
 * than once per endpoint, and both read it through here so "pending" keeps one
 * definition beside the claim predicate below.
 *
 * Covered by the partial `event_delivery_endpoint_idx`, so this stays a small
 * index scan as delivered rows accumulate. Omitting `ids` counts every
 * endpoint, which is what fan-out wants.
 */
export async function pendingDepthByEndpoint(
	db: Db,
	ids?: readonly string[]
): Promise<Map<string, number>> {
	const rows = await db
		.select({ endpointId: eventDelivery.endpointId, depth: sql<number>`count(*)::int` })
		.from(eventDelivery)
		.where(
			ids
				? and(inArray(eventDelivery.endpointId, ids), eq(eventDelivery.status, 'pending'))
				: eq(eventDelivery.status, 'pending')
		)
		.groupBy(eventDelivery.endpointId);

	return new Map(rows.map((row) => [row.endpointId, row.depth]));
}

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
	/**
	 * `EVENT_EGRESS_ENABLED`, forwarded to `postEvent` — which is where the
	 * switch is enforced, so that no caller of it can be the exception.
	 * Unreachable from here in practice: with the switch off phase one claims
	 * nothing, so there is no batch to deliver.
	 */
	enabled: boolean;
	/** Test seam, as on `PostInput`. Never set on the delivery path. */
	lookup?: LookupAll;
}

/**
 * Phase one, under the advisory lock and inside one transaction: claim due
 * rows and push their next attempt forward, exactly as `drainOutbox` does. The
 * pushed-forward claim is what makes phase two safe with no lock held.
 */
export async function claimDeliveries(tx: Db): Promise<ClaimedDelivery[]> {
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
		WHERE rank <= ${PER_ENDPOINT_LIMIT}
		ORDER BY next_attempt_at
		LIMIT ${CLAIM_LIMIT}
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
		WHERE d.id = ANY(${sql.param(candidates.map((row) => row.id))}::uuid[])
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
	// next tick. Through the query builder, unlike the two SELECTs above that it
	// cannot express.
	await tx
		.update(eventDelivery)
		.set({ nextAttemptAt: sql`now() + interval '5 minutes'` })
		.where(
			inArray(
				eventDelivery.id,
				rows.map((row) => row.id)
			)
		);

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

	// One read for the whole batch rather than one per row. The round-robin
	// claim makes "one event owed to N endpoints" the normal shape, not the
	// exception, so the per-row form re-fetched the same audit row once per
	// endpoint.
	//
	// The Drizzle query builder, not raw SQL: a hand-written SELECT returns
	// snake_case keys, and enrichEvent reads camelCase (`actorType`,
	// `subjectType`, ...) — every field would silently be undefined rather
	// than throw, delivering an event with a null subject and empty data.
	const auditRows =
		claimed.length === 0
			? []
			: await db
					.select()
					.from(auditEvent)
					.where(inArray(auditEvent.seq, [...new Set(claimed.map((row) => row.auditSeq))]));
	const audits = new Map(auditRows.map((audit) => [audit.seq, audit]));

	// Enrichment is two to three further queries against rows that do not vary
	// by endpoint, so it is done once per event and reused across the endpoints
	// that event fans out to. The cache lives exactly one batch, which keeps
	// "a retry re-renders from live state" true.
	const enrichments = new Map<bigint, EnrichOutcome>();

	for (const row of claimed) {
		// Started before the render rather than around the POST alone: the
		// histogram is what an operator budgets a tick against, and enrichment is
		// several queries — time this loop spends and the span does not see is
		// exactly the time that would otherwise be unaccounted for, since
		// `trustcenter.job.tick.duration` covers phase one only (spec §5.1).
		const started = performance.now();
		const record = (outcome: 'delivered' | 'failed' | 'skipped') =>
			recordEgressDelivery({
				endpointId: row.endpointId,
				outcome,
				seconds: (performance.now() - started) / 1000
			});

		const audit = audits.get(row.auditSeq);

		// The audit log is append-only, so the row cannot have been deleted — but
		// a delivery whose audit row is somehow absent has nothing to render.
		if (!audit) {
			await markSkipped(db, row.id);
			record('skipped');
			skipped++;
			continue;
		}

		let enriched = enrichments.get(row.auditSeq);
		if (!enriched) {
			enriched = await enrichEvent(db, audit, {
				baseUrl: options.baseUrl,
				locale: options.locale
			});
			enrichments.set(row.auditSeq, enriched);
		}

		if (enriched.kind === 'skip') {
			// Nothing is sent. Blanks are the one shape a consumer cannot branch
			// on (spec §4.5).
			await markSkipped(db, row.id);
			record('skipped');
			skipped++;
			continue;
		}

		// The delivery id is the one field of the payload that varies by
		// endpoint, so it is applied here rather than carried through enrichment.
		const model = { ...enriched.model, deliveryId: row.id };
		const { body, contentType } = formatEvent(row.endpoint.format, model);

		// Refused rather than delivered unsigned, because this format's payload is
		// what a consumer authenticates (spec §7.1). Which formats those are is
		// the registry's to say, not this loop's.
		if (requiresSigning(row.endpoint.format) && options.signingKey === undefined) {
			await recordFailure(db, row, null, 'signing_key_missing', false, null);
			record('failed');
			failed++;
			continue;
		}

		const headers = eventHeaders({
			action: model.action,
			deliveryId: row.id,
			endpointId: row.endpointId,
			secretVersion: row.endpoint.secretVersion,
			signingKey: options.signingKey,
			body
		});

		const outcome = await withSpan(
			'event deliver',
			{
				'egress.endpoint_id': row.endpointId,
				'egress.action': model.action,
				'egress.format': row.endpoint.format,
				'egress.attempt': row.attempts + 1
			},
			async (span) => {
				const result = await postEvent({
					// The stored URL, unvalidated: `postEvent` re-validates it and
					// turns a refusal into this delivery's failure. Validating here
					// instead threw out of the loop and abandoned the rest of the batch.
					url: row.endpoint.url,
					enabled: options.enabled,
					allow: options.allow,
					body,
					contentType,
					headers,
					lookup: options.lookup
				});

				if (result.statusCode !== null) {
					span.setAttribute('http.response.status_code', result.statusCode);
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
			record('delivered');
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
		record('failed');
		failed++;
	}

	return { delivered, failed, skipped };
}

/** The window with no success after which an endpoint disables itself. */
export const DISABLE_AFTER_HOURS = 24;

/**
 * Time-based rather than a consecutive-failure count, which is wrong in both
 * directions: a low-volume deployment takes four days to reach ten failures,
 * so a dead endpoint stays "enabled" and silent for four days, while a
 * high-volume one reaches ten inside a single 25-row batch — so a routine
 * secret_version rotation would auto-disable the endpoint within one tick
 * (spec §5.4).
 *
 * `coalesce(last_success_at, created_at)` because `last_success_at` is NULL
 * for an endpoint that has never succeeded once, which is precisely the
 * permanently-dead case this exists for.
 *
 * The "and at least one attempt in the window" half is what keeps a *quiet*
 * endpoint enabled: an operator whose channel simply had no matching events
 * for a day must not find it disabled.
 */
export async function disableStaleEndpoints(db: Db): Promise<{ disabled: string[] }> {
	const stale = (await db.execute(sql`
		SELECT e.id, e.name, e.format,
		       (SELECT d.last_status_code FROM event_delivery d
		         WHERE d.endpoint_id = e.id AND d.status IN ('failed', 'pending')
		         ORDER BY d.created_at DESC LIMIT 1) AS last_status_code
		FROM event_endpoint e
		WHERE e.enabled = true
		  AND coalesce(e.last_success_at, e.created_at) < now() - make_interval(hours => ${DISABLE_AFTER_HOURS})
		  AND EXISTS (
		    SELECT 1 FROM event_delivery d
		    WHERE d.endpoint_id = e.id
		      AND d.attempts > 0
		      AND d.created_at > now() - make_interval(hours => ${DISABLE_AFTER_HOURS})
		  )
	`)) as unknown as { id: string; name: string; format: string; last_status_code: number | null }[];

	const disabled: string[] = [];

	for (const endpoint of stale) {
		const reason = `no delivery succeeded in ${DISABLE_AFTER_HOURS} hours`;

		const wrote = await db.transaction(async (tx) => {
			// `enabled` and `disabled_at` move together or the row is rejected:
			// event_endpoint_disabled_check makes "disabled" one state rather than
			// two columns that usually agree.
			//
			// `enabled = true` is in the WHERE, and the audit event is written only
			// if this UPDATE actually claimed the row — a compare-and-set, not a
			// blind write. `startJobRunner`'s setInterval does not wait for the
			// previous tick's promise chain and phase two is bounded only by
			// CLAIM_LIMIT * the request timeout, so two runs of this function can
			// in principle overlap on one replica; both would then read
			// `enabled = true` before either wrote and each would append an
			// `event_endpoint.disabled` row for a single disablement, into a table
			// that cannot be deleted from. Under READ COMMITTED the second UPDATE
			// instead blocks on the first's row lock, re-evaluates this WHERE
			// against the committed row, matches nothing, and writes no event.
			//
			// Not covered by a test, deliberately and with the limit stated: two
			// concurrent calls through one pool serialise — the second's SELECT
			// runs after the first has committed and returns no rows at all — so a
			// `Promise.all` test passes identically with this predicate removed. It
			// would assert the invariant while proving nothing. The guard is kept
			// because it is correct and makes the idempotence structural rather
			// than a property of callers happening to be sequential; the sequential
			// path is what the idempotence test above actually covers.
			const claimed = await tx
				.update(eventEndpoint)
				.set({ enabled: false, disabledAt: new Date(), disabledReason: reason })
				.where(and(eq(eventEndpoint.id, endpoint.id), eq(eventEndpoint.enabled, true)))
				.returning({ id: eventEndpoint.id });

			if (claimed.length === 0) return false;

			// The single exception to "egress writes no audit events" (spec §9).
			// Safe because by the time this is written the endpoint is disabled
			// and cannot deliver it, and another endpoint delivering it is
			// desirable. `meta` carries the name and format but NOT the URL: a
			// Teams Workflows URL carries its shared secret in the query string,
			// and this table cannot be deleted from.
			await recordEvent(tx, {
				action: 'event_endpoint.disabled',
				actor: { type: 'system', id: null },
				subjectType: 'event_endpoint',
				subjectId: endpoint.id,
				meta: {
					name: endpoint.name,
					format: endpoint.format,
					reason,
					lastStatusCode: endpoint.last_status_code
				}
			});

			return true;
		});

		if (wrote) disabled.push(endpoint.id);
	}

	return { disabled };
}

/** Terminal and silent: nothing was sent, so there is no status or error. */
async function markSkipped(db: Db, id: string): Promise<void> {
	await db
		.update(eventDelivery)
		.set({ status: 'skipped', lastStatusCode: null, lastError: null })
		.where(eq(eventDelivery.id, id));
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
