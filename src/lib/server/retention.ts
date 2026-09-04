import { and, inArray, lt, sql } from 'drizzle-orm';
import { eventDelivery, outboundEmail, rateLimit } from './db/schema';
import type { Db } from './db';

/**
 * Drops rate-limit counters whose window is long past.
 *
 * The table grows a row per key forever otherwise. Nothing reads a counter
 * older than its window — `consumeRateLimit`'s upsert restarts one it finds
 * aged out — so deleting them changes no decision. Note the direction of the
 * risk: deleting a counter can only ever forgive, never deny, which is why the
 * cutoff is hours rather than minutes.
 */
export async function sweepRateLimits(
	db: Db,
	options: { olderThanHours: number }
): Promise<{ deleted: number }> {
	const deleted = await db
		.delete(rateLimit)
		.where(
			lt(rateLimit.windowStart, sql`now() - make_interval(hours => ${options.olderThanHours})`)
		)
		.returning({ key: rateLimit.key });

	return { deleted: deleted.length };
}

/**
 * Retires the personal data in settled notifications without losing the record
 * that they happened.
 *
 * `outbound_email` otherwise names every address this deployment has ever
 * mailed, forever — a retention policy nobody chose. The rows themselves stay,
 * for the same reason `purgeRequester` keeps them: that a notification went out
 * is a fact about the system rather than about the person. `to` is NOT NULL, so
 * it is blanked rather than nulled, matching that function exactly.
 *
 * `payload` goes too, and not only because it can name the recipient: a
 * `verify_request` payload carries the magic-link URL, and a spent token is
 * still a token.
 *
 * Only settled rows. A pending notification has not been delivered, and
 * blanking its address would strand the mail rather than retire it — the drain
 * would then fail on it forever.
 */
export async function redactDeliveredMail(
	db: Db,
	options: { retentionDays: number }
): Promise<{ redacted: number }> {
	const redacted = await db
		.update(outboundEmail)
		.set({ to: '', payload: {} })
		.where(
			and(
				inArray(outboundEmail.status, ['sent', 'failed']),
				lt(outboundEmail.createdAt, sql`now() - make_interval(days => ${options.retentionDays})`),
				// Already redacted rows are skipped, so a second pass is a no-op
				// rather than a rewrite of every settled row in the table.
				sql`${outboundEmail.to} <> ''`
			)
		)
		.returning({ id: outboundEmail.id });

	return { redacted: redacted.length };
}

/**
 * Drops terminal `event_delivery` rows past the retention window.
 *
 * Terminal deliveries are a log of what went where, and thirty days is long
 * enough to answer "did that approval reach n8n?". Pending rows are never
 * swept, however old: one is still owed a delivery.
 *
 * Nothing here is personal data — `audit_seq` and `audit_id` are references,
 * `last_error` is one of a fixed set of reason phrases (spec §2.3) — so this is
 * a table-size measure rather than an erasure one, and the window is chosen
 * for legibility rather than for a legal obligation.
 */
export async function sweepEventDeliveries(
	db: Db,
	options: { retentionDays: number }
): Promise<{ deleted: number }> {
	const deleted = await db
		.delete(eventDelivery)
		.where(
			and(
				inArray(eventDelivery.status, ['delivered', 'failed', 'skipped']),
				lt(eventDelivery.createdAt, sql`now() - make_interval(days => ${options.retentionDays})`)
			)
		)
		.returning({ id: eventDelivery.id });

	return { deleted: deleted.length };
}
