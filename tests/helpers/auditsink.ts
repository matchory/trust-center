import type { InferInsertModel } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { currentHorizon } from '../../src/lib/server/audit';
import { auditBatch } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/db';

export function batchRow(input: {
	prev: [bigint, bigint];
	cursor: [bigint, bigint];
	rowCount?: number;
}): InferInsertModel<typeof auditBatch> {
	return {
		prevCursorXmin: input.prev[0],
		prevCursorSeq: input.prev[1],
		cursorXmin: input.cursor[0],
		cursorSeq: input.cursor[1],
		rowCount: input.rowCount ?? 1,
		minSeq: 1n,
		maxSeq: 1n,
		byteCount: 10,
		digest: 'x'.repeat(64)
	};
}

/**
 * Puts the cursor at the current horizon so a test starts from "nothing
 * pending" without deleting audit_event rows, which is append-only.
 */
export async function seedCursorAtHorizon(db: Db): Promise<void> {
	const horizon = await currentHorizon(db);
	const [maxSeq] = (await db.execute(
		sql`SELECT coalesce(max(seq), 0)::text AS seq FROM audit_event`
	)) as unknown as { seq: string }[];

	await db.insert(auditBatch).values({
		prevCursorXmin: 0n,
		prevCursorSeq: 0n,
		cursorXmin: horizon,
		cursorSeq: BigInt(maxSeq!.seq),
		rowCount: 0,
		minSeq: 0n,
		maxSeq: 0n,
		byteCount: 0,
		digest: '0'.repeat(64)
	});
}
