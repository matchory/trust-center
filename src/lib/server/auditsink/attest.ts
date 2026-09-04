import { desc, eq, gt, sql } from 'drizzle-orm';
import { auditBatch, setting } from '../db/schema';
import { readCursor } from './reader';
import type { Attestation } from './port';
import type { Db } from '../db';

const SETTING_KEY = 'auditsink.attested_at';

/**
 * The stored mark, or null if the sink has never attested.
 *
 * `setting.value` is jsonb, and the query builder serialises a plain string
 * into it and parses it back out — the same round trip `egress/canary.ts`
 * relies on for its digest. Reading it by hand (`value #>> '{}'`) would be a
 * second idiom for one table, and it would skip the `updatedAt` the other
 * writers of this table maintain.
 */
async function lastAttestedAt(db: Db): Promise<Date | null> {
	const [row] = await db
		.select({ value: setting.value })
		.from(setting)
		.where(eq(setting.key, SETTING_KEY))
		.limit(1);

	if (!row) return null;

	const parsed = Date.parse(String(row.value));
	return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * The attestation exists because the sink is silent in the audit log by
 * design (spec §8), so the log cannot testify that the sink was running.
 * Without a regular series, switching the sink off, deleting rows and
 * switching it back on leaves no trace anywhere (spec §3.4).
 */
export async function attestationDue(db: Db, intervalMs: number): Promise<boolean> {
	const last = await lastAttestedAt(db);

	return last === null || Date.now() - last.getTime() >= intervalMs;
}

/**
 * Write-ordering contract for the (not-yet-written) job that will compose
 * this with `attestationDue` and `buildAttestation`: call this only after
 * `attest()` has actually succeeded for the attestation being marked. A
 * missing attestation is §3.4's only signal, so marking before the adapters
 * have written would silently skip one instead of surfacing the gap.
 *
 * Pass the `at` carried by the attestation that was written, which
 * `buildAttestation` read from the database clock — not `new Date()`. The
 * window below compares against `created_at` on that same clock, and mixing
 * the two reintroduces the skew this function's caller exists to avoid.
 */
export async function markAttested(db: Db, at: Date): Promise<void> {
	await db
		.insert(setting)
		.values({ key: SETTING_KEY, value: at.toISOString() })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value: at.toISOString(), updatedAt: new Date() }
		});
}

export async function buildAttestation(db: Db): Promise<Attestation> {
	const since = await lastAttestedAt(db);

	// Four independent reads, so one round trip rather than four (the shape
	// `egress/endpoints.ts` uses for the same reason).
	const [cursor, height, head, batches] = await Promise.all([
		readCursor(db),
		// `at` comes from the database clock, not `new Date()`: `batches_since`
		// counts `created_at` on that same clock, and stamping `at` from the
		// application clock would double-count or drop batches under skew.
		db.execute(sql`
			SELECT now() AS at, count(*)::text AS event_count, coalesce(max(seq), 0)::text AS max_seq
			FROM audit_event
		`) as unknown as Promise<{ at: Date; event_count: string; max_seq: string }[]>,
		// Unscoped from the since-last-mark window on purpose: it must always
		// name the current head, not the head as of the last mark, or an auditor
		// cross-checking it against the cursor gets a false mismatch. `id` is a
		// v4 UUID, so its lexicographic order says nothing about recency —
		// ordering by cursor is what "most recent" means here.
		db
			.select({ id: auditBatch.id })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1),
		// No mark yet means count every batch, which is why the predicate is
		// omitted rather than compared against the epoch.
		db
			.select({ since: sql<number>`count(*)::int` })
			.from(auditBatch)
			.where(since ? gt(auditBatch.createdAt, since) : undefined)
	]);

	return {
		// postgres-js does not parse an untyped raw-query column, so `at` can
		// arrive as either a Date or its string form depending on the driver
		// path; `new Date(...)` normalizes either into one ISO string.
		at: new Date(height[0]!.at).toISOString(),
		event_count: height[0]!.event_count,
		max_seq: height[0]!.max_seq,
		cursor: { xmin: String(cursor.xmin), seq: String(cursor.seq) },
		last_batch_id: head[0]?.id ?? null,
		batches_since: batches[0]!.since
	};
}
