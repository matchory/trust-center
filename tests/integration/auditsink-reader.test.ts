import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditBatch } from '../../src/lib/server/db/schema';
import { batchRow } from '../helpers/auditsink';
import { rejectionCause } from '../helpers/db';

let db: Db;
let close: () => Promise<void>;
let url: string;

beforeAll(() => {
	url = process.env.TEST_DATABASE_URL ?? '';
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// audit_batch and audit_batch_shipment refuse DELETE and TRUNCATE by
	// design (spec §2.1) — the fixture reset is the one place that must
	// still cross that trigger, so it is done explicitly rather than by
	// dropping and recreating the tables.
	await db.execute(sql`ALTER TABLE audit_batch DISABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment DISABLE TRIGGER USER`);
	await db.execute(sql`TRUNCATE TABLE audit_batch_shipment, audit_batch`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment ENABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch ENABLE TRIGGER USER`);
});

describe('audit_batch is append-only and monotonic', () => {
	it('rejects a batch whose prev cursor does not match the head', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		expect(
			await rejectionCause(
				db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [20n, 1n] }))
			)
		).toMatch(/cursor chain broken/);
	});

	it('rejects a batch whose cursor does not advance', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		expect(
			await rejectionCause(
				db.insert(auditBatch).values(batchRow({ prev: [10n, 5n], cursor: [10n, 5n] }))
			)
		).toMatch(/cursor must advance/);
	});

	it('accepts a forward re-seed after a restore', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		await db
			.insert(auditBatch)
			.values(batchRow({ prev: [10n, 5n], cursor: [99_999n, 0n], rowCount: 0 }));

		const [head] = await db
			.select({ xmin: auditBatch.cursorXmin })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1);
		expect(head!.xmin).toBe(99_999n);
	});

	it('refuses UPDATE and DELETE', async () => {
		const [row] = await db
			.insert(auditBatch)
			.values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }))
			.returning({ id: auditBatch.id });

		expect(
			await rejectionCause(
				db.update(auditBatch).set({ rowCount: 99 }).where(eq(auditBatch.id, row!.id))
			)
		).toMatch(/append-only/);
		expect(
			await rejectionCause(db.delete(auditBatch).where(eq(auditBatch.id, row!.id)))
		).toMatch(/append-only/);
	});
});
