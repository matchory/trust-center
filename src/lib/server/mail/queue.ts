import { SpanKind } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { outboundEmail } from '../db/schema';
import { renderTemplate } from './templates';
import { withSpan } from '../telemetry';
import type { MailPayload, MailTemplate } from './templates';
import type { MailAdapter, MailAttachment, OutgoingMail } from './index';
import type { StorageAdapter } from '../storage';
import type { Db } from '../db';

/** Five attempts over roughly a quarter of an hour, then a permanent failure. */
const MAX_ATTEMPTS = 5;

export async function enqueueEmail(
	db: Db,
	input: { to: string; template: MailTemplate; locale: string; payload: MailPayload }
): Promise<void> {
	await db.insert(outboundEmail).values({
		to: input.to,
		template: input.template,
		locale: input.locale,
		payload: input.payload
	});
}

/**
 * Every row still waiting to go out, rows in retry backoff included — this
 * counts what is queued, not what the next `drainOutbox` tick would claim.
 * Lives here rather than at the caller so the definition of "queued" stays with
 * the claim predicate above it: telemetry owns the instrument, this module owns
 * what the number means.
 */
export async function pendingCount(db: Db): Promise<number> {
	const rows = (await db.execute(
		sql`SELECT count(*)::int AS depth FROM outbound_email WHERE status = 'pending'`
	)) as unknown as { depth: number }[];

	return rows[0]?.depth ?? 0;
}

interface ClaimedRow {
	id: string;
	to: string;
	template: MailTemplate;
	locale: string;
	payload: MailPayload;
	attempts: number;
}

/**
 * Claims due rows with FOR UPDATE SKIP LOCKED inside one transaction, so a
 * second drain — in this process or another replica — walks past them rather
 * than sending the same mail twice. The claim pushes each row's next attempt
 * ahead, so a crash mid-send retries later rather than being retried by the
 * very next tick.
 *
 * `mailer`, `from` and `storage` are passed in rather than resolved from config
 * here: this module would otherwise need a fully configured environment to
 * drain a queue, which is both untestable and more than it needs to know. The
 * job that calls it owns those lookups.
 */
export async function drainOutbox(
	db: Db,
	options: { limit: number; mailer: MailAdapter; from: string; storage: StorageAdapter }
): Promise<{ sent: number; failed: number }> {
	const claimed = await db.transaction(async (tx) => {
		const rows = (await tx.execute(sql`
			SELECT id, "to", template, locale, payload, attempts
			FROM outbound_email
			WHERE status = 'pending' AND next_attempt_at <= now()
			ORDER BY next_attempt_at
			LIMIT ${options.limit}
			FOR UPDATE SKIP LOCKED
		`)) as unknown as ClaimedRow[];

		if (rows.length > 0) {
			await tx.execute(sql`
				UPDATE outbound_email
				SET next_attempt_at = now() + interval '5 minutes'
				WHERE id = ANY(${sql.param(rows.map((r) => r.id))}::uuid[])
			`);
		}

		return rows;
	});

	if (claimed.length === 0) return { sent: 0, failed: 0 };

	const { mailer, from, storage } = options;
	let sent = 0;
	let failed = 0;

	for (const row of claimed) {
		try {
			const rendered = renderTemplate(row.template, row.locale, row.payload);
			// Read before the send, so a missing object fails the row through the
			// same retry path as an SMTP error. A mail that went out with the
			// attachment silently dropped would be worse than one that did not go.
			const attachments = await resolveAttachments(storage, row.payload);

			const { providerId } = await withSpan(
				'mail send',
				// The template and locale, never `row.to`: the recipient is personal
				// data and telemetry leaves the reach of `purgeRequester` (spec §8).
				{ 'mail.template': row.template, 'mail.locale': row.locale },
				() =>
					mailer.send({
						to: row.to,
						from,
						subject: rendered.subject,
						text: rendered.text,
						attachments
					}),
				// CLIENT, because this is the application's only outbound egress
				// (spec §4) — see `withSpan`'s `kind` for why it is not left INTERNAL.
				SpanKind.CLIENT
			);

			await db.execute(sql`
				UPDATE outbound_email
				SET status = 'sent', sent_at = now(), provider_id = ${providerId ?? null},
				    attempts = attempts + 1, last_error = NULL
				WHERE id = ${row.id}::uuid
			`);
			sent++;
		} catch (cause) {
			const attempts = Number(row.attempts) + 1;
			const giveUp = attempts >= MAX_ATTEMPTS;
			const message = cause instanceof Error ? cause.message : String(cause);

			// Exponential backoff: 1, 2, 4, 8 minutes.
			await db.execute(sql`
				UPDATE outbound_email
				SET status = ${giveUp ? 'failed' : 'pending'},
				    attempts = ${attempts},
				    last_error = ${message},
				    next_attempt_at = now() + make_interval(mins => ${2 ** (attempts - 1)})
				WHERE id = ${row.id}::uuid
			`);
			failed++;
		}
	}

	return { sent, failed };
}

/**
 * Turns the keys a queue row carries into bytes. `stream` throws
 * `StorageObjectNotFound` for an object a purge removed between queueing and
 * draining, which the caller's retry-then-fail path already handles.
 */
async function resolveAttachments(
	storage: StorageAdapter,
	payload: MailPayload
): Promise<OutgoingMail['attachments']> {
	const spec = payload.attachments;
	if (!Array.isArray(spec) || spec.length === 0) return undefined;

	return Promise.all(
		(spec as readonly MailAttachment[]).map(async (attachment) => ({
			filename: attachment.filename,
			contentType: attachment.contentType,
			content: new Uint8Array(
				await new Response(await storage.stream(attachment.storageKey)).arrayBuffer()
			)
		}))
	);
}
