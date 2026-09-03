import { eq, sql } from 'drizzle-orm';
import { eventDelivery, eventEndpoint, eventEndpointFilter } from '../db/schema';
import { matchesPattern } from './filter';
import type { Db } from '../db';

/** How much of the log one tick reads per endpoint. */
export const FANOUT_LIMIT = 500;
/**
 * Above this pending depth an endpoint stops being fanned out. Without it the
 * two limits fight: 500 fanned out per tick against 25 delivered per tick
 * means a catch-up grows event_delivery twenty times faster than it drains it
 * (spec §5.2).
 */
export const BACKPRESSURE_THRESHOLD = 1000;

/**
 * The oldest transaction id still running. Everything inserted by a
 * transaction below it has completed.
 *
 * `pg_snapshot_xmin` is epoch-extended `xid8`, but the row side of the
 * comparison in fanOut is a bare 32-bit `xid` widened by `::text::bigint`:
 * Postgres exposes no way to recover a tuple's epoch. The comparison is
 * therefore valid within one xid epoch and not across a rollover, and past one
 * it does not degrade, it breaks two ways — `xmin < horizon` becomes
 * universally true, so the visibility predicate stops excluding anything; and
 * an endpoint seeded with a horizon above 2^32 holds a cursor no raw `xmin`
 * can ever exceed, so it delivers nothing at all rather than a stranded row.
 * Centuries away at this system's write rate, and recorded as a residual
 * rather than engineered around (spec §16).
 */
export async function currentHorizon(db: Db): Promise<bigint> {
	const rows = (await db.execute(
		sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS horizon`
	)) as unknown as { horizon: string }[];

	return BigInt(rows[0]!.horizon);
}

/**
 * Fans out newly-final audit events into per-endpoint deliveries, and advances
 * each endpoint's cursor.
 *
 * **The cursor is a keyset on `(xmin, seq)`, not a `seq` high-watermark.** A
 * seq watermark cannot be made correct here: `nextval()` is consumed at INSERT
 * and a row becomes visible at COMMIT, and because recordEvent is called last
 * in a transaction, xid order and seq order diverge. Two distinct events are
 * dropped by two distinct seq-based schemes —
 *
 * - a plain `seq > cursor` scan misses a row whose transaction is still open
 *   and then moves past it;
 * - a `seq > cursor` scan filtered by `xmin < horizon` misses a *committed*
 *   row whose transaction started after the oldest running one, because that
 *   row is excluded by the horizon while a lower-xid transaction's higher seq
 *   is scanned — and the cursor moves past it.
 *
 * The keyset closes both, and the invariant is worth stating exactly: the
 * cursor is only ever set to a row whose `xmin` was strictly below the horizon
 * observed in that same tick. Every unconsumed row — invisible (its
 * transaction is running, so its xid is at or above that horizon) or
 * visible-but-excluded (same) — therefore has a key strictly greater than the
 * cursor. Each row is consumed exactly once, in the tick where the horizon
 * crosses its xmin. Both failure modes are asserted in
 * tests/integration/egress-fanout.test.ts.
 *
 * The failure mode this trades into is **delay, not loss**: a long-running
 * transaction holds the horizon back and events wait for it. That is the right
 * direction, and it is bounded by the longest transaction in the system rather
 * than unbounded.
 *
 * Ordering is by `(xmin, seq)` — roughly commit order rather than seq order.
 * §15 promises no delivery ordering, and `seq` in the payload still makes a
 * gap detectable; a consumer must not assume monotonicity.
 *
 * The window scan is sequential: `xmin::text::bigint` is not indexable (a
 * system column, and not an immutable expression). At this system's scale —
 * a trust center writes thousands of audit events a month — that is a
 * sub-millisecond scan every fifteen seconds. If `audit_event` ever passes
 * roughly a million rows, add a `seq > cursor_seq - N` bound and record the
 * resulting bounded gap; do not add it speculatively.
 */
export async function fanOut(tx: Db): Promise<{ enqueued: number; paused: string[] }> {
	const horizon = await currentHorizon(tx);

	const endpoints = await tx
		.select({
			id: eventEndpoint.id,
			cursorXmin: eventEndpoint.cursorXmin,
			cursorSeq: eventEndpoint.cursorSeq
		})
		.from(eventEndpoint)
		// A disabled endpoint is excluded here rather than skipped in the loop, so
		// its cursor cannot advance by any later edit to the body: the stalled
		// cursor is what makes re-enabling an explicit choice with the backlog in
		// front of the operator (spec §5.5).
		.where(eq(eventEndpoint.enabled, true));

	let enqueued = 0;
	const paused: string[] = [];

	for (const endpoint of endpoints) {
		const depth = (await tx.execute(
			sql`SELECT count(*)::int AS depth FROM event_delivery
			    WHERE endpoint_id = ${endpoint.id}::uuid AND status = 'pending'`
		)) as unknown as { depth: number }[];

		if ((depth[0]?.depth ?? 0) > BACKPRESSURE_THRESHOLD) {
			// Pausing must leave the cursor where it is — the cursor is the
			// backlog's durable record, so a paused endpoint resumes exactly where
			// it stopped once the queue drains.
			paused.push(endpoint.id);
			continue;
		}

		const patterns = (
			await tx
				.select({ pattern: eventEndpointFilter.pattern })
				.from(eventEndpointFilter)
				.where(eq(eventEndpointFilter.endpointId, endpoint.id))
		).map((row) => row.pattern);

		// The window is read WITHOUT the filter applied, so the cursor advances
		// past events that were scanned but did not match — advancing only past
		// matches would re-scan every unmatched event forever. Matching then runs
		// in process against `matchesPattern`, which keeps one implementation of
		// the pattern rule rather than a SQL one that has to agree with it.
		const window = (await tx.execute(sql`
			SELECT id, seq, action, xmin::text::bigint AS xmin
			FROM audit_event
			WHERE xmin::text::bigint < ${horizon}
			  AND (xmin::text::bigint, seq) > (${endpoint.cursorXmin}, ${endpoint.cursorSeq})
			ORDER BY xmin::text::bigint, seq
			LIMIT ${FANOUT_LIMIT}
		`)) as unknown as { id: string; seq: string; action: string; xmin: string }[];

		if (window.length === 0) continue;

		const matching =
			patterns.length === 0
				? []
				: window.filter((row) => patterns.some((pattern) => matchesPattern(pattern, row.action)));

		if (matching.length > 0) {
			await tx
				.insert(eventDelivery)
				.values(
					matching.map((row) => ({
						endpointId: endpoint.id,
						auditSeq: BigInt(row.seq),
						auditId: row.id
					}))
				)
				// What makes a replayed fan-out a no-op, so a crash between this
				// insert and the cursor update below is safe — and what absorbs the
				// re-scan purgeRequester's UPDATE of audit_event causes, since that
				// bumps a row's xmin above the cursor again.
				.onConflictDoNothing({
					target: [eventDelivery.endpointId, eventDelivery.auditSeq]
				});
			enqueued += matching.length;
		}

		// The LAST row of the window, never `max(seq)`: the window is ordered by
		// the same key the cursor is compared on, and a max over one column of a
		// composite key would strand every row whose seq is below it but whose
		// xmin has yet to cross the horizon.
		const last = window[window.length - 1]!;
		await tx
			.update(eventEndpoint)
			.set({ cursorXmin: BigInt(last.xmin), cursorSeq: BigInt(last.seq) })
			.where(eq(eventEndpoint.id, endpoint.id));
	}

	return { enqueued, paused };
}
