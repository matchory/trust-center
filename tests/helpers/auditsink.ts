import type { InferInsertModel } from 'drizzle-orm';
import { auditBatch } from '../../src/lib/server/db/schema';

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
