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

export async function markAttested(db: Db, at: Date): Promise<void> {
	await db.execute(sql`
		INSERT INTO setting (key, value)
		VALUES (${SETTING_KEY}, ${JSON.stringify(at.toISOString())}::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`);
}

export async function buildAttestation(db: Db): Promise<Attestation> {
	const cursor = await readCursor(db);

	const [height] = (await db.execute(sql`
		SELECT count(*)::text AS event_count, coalesce(max(seq), 0)::text AS max_seq
		FROM audit_event
	`)) as unknown as { event_count: string; max_seq: string }[];

	const [batches] = (await db.execute(sql`
		SELECT count(*)::text AS since, max(id::text) AS last_id
		FROM audit_batch
		WHERE created_at > coalesce(
			(SELECT (value #>> '{}')::timestamptz FROM setting WHERE key = ${SETTING_KEY}),
			'-infinity'::timestamptz
		)
	`)) as unknown as { since: string; last_id: string | null }[];

	return {
		at: new Date().toISOString(),
		event_count: height!.event_count,
		max_seq: height!.max_seq,
		cursor: { xmin: String(cursor.xmin), seq: String(cursor.seq) },
		last_batch_id: batches!.last_id,
		batches_since: Number(batches!.since)
	};
}
