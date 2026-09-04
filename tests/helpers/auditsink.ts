import { randomUUID } from 'node:crypto';
import type { InferInsertModel } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { currentHorizon, recordEvent } from '../../src/lib/server/audit';
import type { AuditSinkAdapter } from '../../src/lib/server/auditsink/port';
import { SinkError } from '../../src/lib/server/auditsink/port';
import { readCursor } from '../../src/lib/server/auditsink/reader';
import { auditBatch } from '../../src/lib/server/db/schema';
import type { SinkName } from '../../src/lib/server/db/schema';
import { upsertRequester } from '../../src/lib/server/identity/requester';
import type { Db } from '../../src/lib/server/db';
import type { StorageAdapter } from '../../src/lib/server/storage';

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

/**
 * Inserts a batch row chained from the current head, so it satisfies the
 * monotonicity trigger (drizzle/0003): its `prev_cursor_*` is read from the
 * head rather than hardcoded, and its own cursor strictly advances one seq
 * past it.
 */
export async function insertBatch(
	db: Db,
	input: { rowCount?: number } = {}
): Promise<{ id: string }> {
	const head = await readCursor(db);
	const next: [bigint, bigint] = [head.xmin, head.seq + 1n];

	const [row] = await db
		.insert(auditBatch)
		.values(batchRow({ prev: [head.xmin, head.seq], cursor: next, rowCount: input.rowCount }))
		.returning({ id: auditBatch.id });

	return { id: row!.id };
}

/** A sink double that ships and attests successfully every time. */
export function alwaysSucceeds(sink: SinkName): AuditSinkAdapter {
	return {
		name: sink,
		async ship(batch) {
			return `audit/${batch.id}.ndjson`;
		},
		async attest() {}
	};
}

/** A sink double that fails every shipment with a `network` reason. */
export function alwaysFails(sink: SinkName): AuditSinkAdapter {
	return {
		name: sink,
		async ship(): Promise<string> {
			throw new SinkError('network');
		},
		async attest() {}
	};
}

/** Ships the first `n` batches it is asked to, then fails every one after. */
export function failingAfter(n: number, sink: SinkName = 's3'): AuditSinkAdapter {
	let shipped = 0;

	return {
		name: sink,
		async ship(batch): Promise<string> {
			shipped++;
			if (shipped > n) throw new SinkError('network');

			return `audit/${batch.id}.ndjson`;
		},
		async attest() {}
	};
}

/** A StorageAdapter double for tests that never read or write an object. */
export const nullStorage: StorageAdapter = {
	async put(key) {
		return { key, size: 0, sha256: '' };
	},
	async stream() {
		throw new Error('nullStorage: no object is ever stored');
	},
	async stat() {
		return null;
	},
	async delete() {}
};

/**
 * Creates a verified requester and one audit event attributed to it, so a test
 * can build a batch containing it and then purge it (spec §4.3).
 */
export async function seedRequesterWithAuditEvent(db: Db): Promise<{ requesterId: string }> {
	const requesterRow = await upsertRequester(db, {
		email: `auditsink-${randomUUID()}@example.test`,
		name: 'Audit Sink Fixture',
		company: 'Acme',
		locale: 'de'
	});

	await recordEvent(db, {
		action: 'test.auditsink',
		actor: { type: 'requester', id: requesterRow.id }
	});

	return { requesterId: requesterRow.id };
}
