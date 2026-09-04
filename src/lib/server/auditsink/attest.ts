import { sql } from 'drizzle-orm';
import { readCursor } from './reader';
import type { Attestation } from './port';
import type { Db } from '../db';

const SETTING_KEY = 'auditsink.attested_at';

/**
 * The attestation exists because the sink is silent in the audit log by
 * design (spec §8), so the log cannot testify that the sink was running.
 * Without a regular series, switching the sink off, deleting rows and
 * switching it back on leaves no trace anywhere (spec §3.4).
 */
export async function attestationDue(db: Db, intervalMs: number): Promise<boolean> {
	// `#>> '{}'` extracts a jsonb scalar as text: the column is jsonb, so the
	// value is a quoted JSON string and `value::timestamptz` would not parse.
	const rows = (await db.execute(sql`
		SELECT value #>> '{}' AS value FROM setting WHERE key = ${SETTING_KEY} LIMIT 1
	`)) as unknown as { value: string }[];

	const last = rows[0] ? Date.parse(rows[0].value) : 0;
	return Number.isNaN(last) || Date.now() - last >= intervalMs;
}

/**
 * Write-ordering contract for the (not-yet-written) job that will compose
 * this with `attestationDue` and `buildAttestation`: call this only after
 * `attest()` has actually succeeded for the attestation being marked. A
 * missing attestation is §3.4's only signal, so marking before the adapters
 * have written would silently skip one instead of surfacing the gap.
 */
export async function markAttested(db: Db, at: Date): Promise<void> {
	await db.execute(sql`
		INSERT INTO setting (key, value)
		VALUES (${SETTING_KEY}, ${JSON.stringify(at.toISOString())}::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`);
}

export async function buildAttestation(db: Db): Promise<Attestation> {
	const cursor = await readCursor(db);

	// `at` is read from the database clock, not `new Date()`: `batches_since`
	// below counts `created_at > last mark` on the same clock, and stamping
	// `at` from the application clock would double-count or drop batches under
	// skew between the two (finding 6).
	const [height] = (await db.execute(sql`
		SELECT now() AS at, count(*)::text AS event_count, coalesce(max(seq), 0)::text AS max_seq
		FROM audit_event
	`)) as unknown as { at: Date; event_count: string; max_seq: string }[];

	// last_batch_id is unscoped from the since-last-mark window on purpose: it
	// must always name the current head, not the head as of the last mark, or
	// an auditor cross-checking it against the cursor gets a false mismatch
	// (finding 1). row id is a v4 UUID, so its lexicographic order has no
	// relationship to recency — ordering by cursor is what "most recent" means.
	const [head] = (await db.execute(sql`
		SELECT id FROM audit_batch ORDER BY cursor_xmin DESC, cursor_seq DESC LIMIT 1
	`)) as unknown as { id: string }[];

	const [batches] = (await db.execute(sql`
		SELECT count(*)::text AS since
		FROM audit_batch
		WHERE created_at > coalesce(
			(SELECT (value #>> '{}')::timestamptz FROM setting WHERE key = ${SETTING_KEY}),
			'-infinity'::timestamptz
		)
	`)) as unknown as { since: string }[];

	return {
		// postgres-js does not parse an untyped raw-query column, so `at` can
		// arrive as either a Date or its string form depending on the driver
		// path; `new Date(...)` normalizes either into one ISO string.
		at: new Date(height!.at).toISOString(),
		event_count: height!.event_count,
		max_seq: height!.max_seq,
		cursor: { xmin: String(cursor.xmin), seq: String(cursor.seq) },
		last_batch_id: head?.id ?? null,
		batches_since: Number(batches!.since)
	};
}
