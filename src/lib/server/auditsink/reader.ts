import { sql } from 'drizzle-orm';
import { currentHorizon } from '../audit';
import { auditBatch } from '../db/schema';
import { AUDIT_SELECT, buildManifest, seqRange, serializeBatch } from './serialize';
import type { AuditRowText } from './serialize';
import type { SinkBatch } from './port';
import type { Db } from '../db';

export interface ReaderOptions {
	batchRows: number;
	maxAgeMs: number;
	maxBytes: number;
}

/**
 * The cursor is the greatest `(cursor_xmin, cursor_seq)` in audit_batch — the
 * batch table IS the cursor (spec §2.1), so there is no state in which the
 * cursor has advanced past rows no batch describes.
 */
export async function readCursor(tx: Db): Promise<{ xmin: bigint; seq: bigint }> {
	const rows = (await tx.execute(sql`
		SELECT cursor_xmin::text AS xmin, cursor_seq::text AS seq
		FROM audit_batch
		ORDER BY cursor_xmin DESC, cursor_seq DESC
		LIMIT 1
	`)) as unknown as { xmin: string; seq: string }[];

	const head = rows[0];
	return head ? { xmin: BigInt(head.xmin), seq: BigInt(head.seq) } : { xmin: 0n, seq: 0n };
}

/**
 * Reads one window and, if it qualifies, records a batch.
 *
 * A batch is built when the window is full, when its oldest row is older than
 * maxAge, or when the body would exceed maxBytes. Without the age rule the row
 * limit is only a maximum: at this system's volume — thousands of audit events
 * a month against a periodic tick — a mostly-empty window would ship as its
 * own batch, which is an undeletable object per row rather than per window
 * (spec §3.2).
 *
 * The keyset invariant is subsystem A's (fanOut's docstring, egress/fanout.ts)
 * and is why this is correct: the cursor is only ever set to a row whose xmin
 * was strictly below the horizon read in this same call, so every unconsumed
 * row has a key strictly greater than the cursor. This reader reimplements the
 * window without A's per-endpoint filtering; it does not import from egress/
 * (spec §1.1 — both subsystems answer "which rows are final" the same way,
 * without sharing code that crosses the subsystem boundary).
 */
export async function buildBatch(tx: Db, options: ReaderOptions): Promise<SinkBatch | null> {
	// Independent of each other, so one round trip rather than two.
	const [horizon, cursor] = await Promise.all([currentHorizon(tx), readCursor(tx)]);

	const window = (await tx.execute(sql`
		SELECT ${sql.raw(AUDIT_SELECT)},
		       xmin::text::bigint AS xmin,
		       (at < now() - make_interval(secs => ${options.maxAgeMs / 1000})) AS aged
		FROM audit_event
		WHERE xmin::text::bigint < ${horizon}
		  AND (xmin::text::bigint, seq) > (${cursor.xmin}, ${cursor.seq})
		ORDER BY xmin::text::bigint, seq
		LIMIT ${options.batchRows}
	`)) as unknown as (AuditRowText & { xmin: string; aged: boolean })[];

	if (window.length === 0) return null;

	// Trimmed to the byte cap before deciding whether the batch qualifies: meta
	// is unbounded jsonb, so without this both the body and the eventual PUT are
	// unbounded (spec §3.2).
	let rows = window;
	let serialized = serializeBatch(rows);

	while (rows.length > 1 && serialized.body.byteLength > options.maxBytes) {
		rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
		serialized = serializeBatch(rows);
	}

	const full = window.length >= options.batchRows;
	const aged = rows[0]!.aged;
	const overflowed = rows.length < window.length;

	if (!full && !aged && !overflowed) return null;

	const last = rows[rows.length - 1]!;
	const { min: minSeq, max: maxSeq } = seqRange(rows);

	const [inserted] = await tx
		.insert(auditBatch)
		.values({
			prevCursorXmin: cursor.xmin,
			prevCursorSeq: cursor.seq,
			cursorXmin: BigInt(last.xmin),
			cursorSeq: BigInt(last.seq),
			rowCount: rows.length,
			minSeq,
			maxSeq,
			byteCount: serialized.body.byteLength,
			digest: serialized.digest
		})
		.returning({ id: auditBatch.id, createdAt: auditBatch.createdAt });

	return {
		id: inserted!.id,
		body: serialized.body,
		digest: serialized.digest,
		manifest: buildManifest({
			id: inserted!.id,
			createdAt: inserted!.createdAt.toISOString(),
			prevCursor: cursor,
			cursor: { xmin: BigInt(last.xmin), seq: BigInt(last.seq) },
			rowCount: rows.length,
			minSeq,
			maxSeq,
			byteCount: serialized.body.byteLength,
			digest: serialized.digest
		})
	};
}
