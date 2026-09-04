import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import { buildBatch } from '../../src/lib/server/auditsink/reader';
import { AUDIT_COLUMNS } from '../../src/lib/server/auditsink/serialize';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditBatch, auditBatchShipment, auditEvent } from '../../src/lib/server/db/schema';
import { batchRow, seedCursorAtHorizon } from '../helpers/auditsink';
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
		expect(await rejectionCause(db.delete(auditBatch).where(eq(auditBatch.id, row!.id)))).toMatch(
			/append-only/
		);
	});

	// A row-level DELETE trigger does not fire on TRUNCATE (drizzle/0004's own
	// reasoning, mirrored here) — the `beforeEach` above truncates with
	// triggers disabled precisely so this guard stays untested by the fixture
	// itself; these assert it fires once triggers are back on.
	it('refuses TRUNCATE', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		expect(await rejectionCause(db.execute(sql`TRUNCATE TABLE audit_batch CASCADE`))).toMatch(
			/audit_batch is append-only: the table cannot be truncated/
		);
	});

	it('refuses TRUNCATE on audit_batch_shipment', async () => {
		const [row] = await db
			.insert(auditBatch)
			.values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }))
			.returning({ id: auditBatch.id });
		await db.insert(auditBatchShipment).values({ batchId: row!.id, sink: 's3' });

		expect(await rejectionCause(db.execute(sql`TRUNCATE TABLE audit_batch_shipment`))).toMatch(
			/audit_batch_shipment is append-only: the table cannot be truncated/
		);
	});
});

async function seqOf(subjectId: string): Promise<string> {
	const [row] = await db
		.select({ seq: auditEvent.seq })
		.from(auditEvent)
		.where(eq(auditEvent.subjectId, subjectId))
		.limit(1);
	if (!row) throw new Error(`no event for ${subjectId}`);
	return String(row.seq);
}

describe('buildBatch', () => {
	const options = { batchRows: 1000, maxAgeMs: 15 * 60_000, maxBytes: 8 * 1024 * 1024 };

	it('returns null when the window is empty', async () => {
		await seedCursorAtHorizon(db);
		expect(await buildBatch(db, options)).toBeNull();
	});

	it('builds nothing until the window fills or ages', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.one' });

		// Two rows, a limit of 1000, and nothing old enough yet.
		expect(await buildBatch(db, { ...options, maxAgeMs: 60 * 60_000 })).toBeNull();
	});

	it('builds when the row limit is reached', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 3; i++) {
			await recordEvent(db, { actor: { type: 'system', id: null }, action: `test.${i}` });
		}

		const batch = await buildBatch(db, { ...options, batchRows: 3, maxAgeMs: 60 * 60_000 });
		expect(batch?.manifest.row_count).toBe(3);
	});

	it('builds when the oldest unbatched row is older than maxAge', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.aged' });

		const batch = await buildBatch(db, { ...options, maxAgeMs: 0 });
		expect(batch?.manifest.row_count).toBe(1);
	});

	it('advances the cursor to the last row of the window, not max(seq)', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.a' });
		const batch = await buildBatch(db, { ...options, maxAgeMs: 0 });

		const [head] = await db
			.select({ xmin: auditBatch.cursorXmin, seq: auditBatch.cursorSeq })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1);

		expect(String(head!.seq)).toBe(batch!.manifest.cursor.seq);
	});

	it('does not re-read a row the previous batch consumed', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.first' });
		await buildBatch(db, { ...options, maxAgeMs: 0 });

		expect(await buildBatch(db, { ...options, maxAgeMs: 0 })).toBeNull();
	});

	it('caps the batch by bytes when rows are large', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 5; i++) {
			await recordEvent(db, {
				actor: { type: 'system', id: null },
				action: `test.big.${i}`,
				meta: { pad: 'x'.repeat(2000) }
			});
		}

		const batch = await buildBatch(db, { ...options, maxAgeMs: 0, maxBytes: 4000 });
		expect(batch!.manifest.row_count).toBeLessThan(5);
		expect(batch!.manifest.byte_count).toBeLessThanOrEqual(4000);
	});

	it('declares every column of audit_event', async () => {
		const rows = (await db.execute(sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'audit_event'
		`)) as unknown as { column_name: string }[];

		// Spec §4.1 / §13: a migration adding a column must fail here rather than
		// silently dropping it from every future object. If this fails, add the
		// column to AUDIT_COLUMNS and bump SERIALIZATION_VERSION.
		expect(new Set(rows.map((r) => r.column_name))).toEqual(new Set(AUDIT_COLUMNS));
	});
});

/**
 * Ported from tests/integration/egress-fanout.test.ts's "the visibility
 * watermark" — subsystem B reimplements A's (xmin, seq) keyset window rather
 * than importing it (spec §1.1), so it needs its own proof of the same two
 * failure modes fanOut's docstring names. `buildBatch` has no per-endpoint
 * filter or cursor, so these read as a single global window instead of one
 * per endpoint, but the invariant under test — that the window predicate
 * cannot both use and drop the xmin half of the keyset without dropping or
 * duplicating a row — is identical.
 */
describe('buildBatch keyset', () => {
	const options = { batchRows: 1000, maxAgeMs: 0, maxBytes: 8 * 1024 * 1024 };

	/**
	 * GUARD 1 — the failure a naive `WHERE seq > cursor.seq` scan has.
	 *
	 * `audit_event.seq` is a bigserial: `nextval()` is consumed at INSERT but a
	 * row becomes visible at COMMIT, and those two orders are not the same. A
	 * scan landing while an earlier-seq transaction is still open sees the
	 * later-seq one first, and moving the cursor past it strands the earlier
	 * row forever once its transaction finally commits (spec §5.2, ported from
	 * egress-fanout.test.ts).
	 */
	it('does not build a batch for a row whose transaction is still open, and includes it once committed', async () => {
		await seedCursorAtHorizon(db);
		const slowSubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		const slow = createDb(url);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));

		// A transaction that takes a LOW seq and stays open.
		const held = slow.db.transaction(async (tx) => {
			await recordEvent(tx, {
				action: 'test.slow',
				actor: { type: 'system', id: null },
				subjectType: 'test',
				subjectId: slowSubject
			});
			await gate;
		});

		// Give the held transaction time to reach the gate, then take a HIGHER
		// seq and commit first.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await recordEvent(db, {
			action: 'test.fast',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: fastSubject
		});

		const fastSeq = await seqOf(fastSubject);

		// The window scanned here consumes NOTHING: the committed row's
		// inserting transaction started after the still-open one, so it is above
		// the horizon.
		expect(await buildBatch(db, options)).toBeNull();

		release();
		await held;
		await slow.close();

		const slowSeq = await seqOf(slowSubject);
		// The trace only means something if the seqs really are out of order.
		expect(BigInt(slowSeq)).toBeLessThan(BigInt(fastSeq));

		const batch = await buildBatch(db, options);
		expect(batch?.manifest.row_count).toBe(2);
		expect(batch?.manifest.min_seq).toBe(slowSeq);
		expect(batch?.manifest.max_seq).toBe(fastSeq);
	});

	/**
	 * GUARD 2 — the failure the xmin-horizon filter still has on its own, and
	 * the reason the cursor is a keyset on (xmin, seq) rather than a seq
	 * high-watermark.
	 *
	 * `xmin < horizon` excludes rows from still-running transactions. It does
	 * NOT exclude rows from transactions that started later, committed
	 * already, and are excluded by that same predicate — and those can hold a
	 * lower seq, because a transaction's xid is assigned at its first write
	 * while its seq is assigned when recordEvent runs last (spec §5.2, ported
	 * from egress-fanout.test.ts).
	 */
	it('delivers a committed row whose xid is above the horizon but whose seq is below a scanned row', async () => {
		await seedCursorAtHorizon(db);
		const earlySubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		// T_early: an xid assigned before T_slow's, committing after T_fast.
		const early = createDb(url);
		let releaseEarly: () => void = () => {};
		const earlyGate = new Promise<void>((resolve) => (releaseEarly = resolve));

		// T_slow: holds the horizon down for the whole tick and writes nothing.
		const slow = createDb(url);
		let releaseSlow: () => void = () => {};
		const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));

		const heldEarly = early.db.transaction(async (tx) => {
			// Forces xid assignment without writing an audit row, so this
			// transaction's xid is low while its seq will be high.
			await tx.execute(sql`SELECT txid_current()`);
			await earlyGate;
			await recordEvent(tx, {
				action: 'test.early',
				actor: { type: 'system', id: null },
				subjectType: 'test',
				subjectId: earlySubject
			});
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		const heldSlow = slow.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT txid_current()`);
			await slowGate;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		// T_fast: a later xid, a LOWER seq than T_early's will be, commits now.
		await recordEvent(db, {
			action: 'test.fast',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: fastSubject
		});

		// T_early now takes its (higher) seq and commits.
		releaseEarly();
		await heldEarly;
		await early.close();

		const fastSeq = await seqOf(fastSubject);
		const earlySeq = await seqOf(earlySubject);
		// The interleaving must really have happened, or this test proves nothing.
		expect(BigInt(fastSeq)).toBeLessThan(BigInt(earlySeq));

		// T_slow still holds the horizon, so T_early's row is scanned (its xid
		// is below the horizon) while T_fast's is not (its xid is above).
		const batch1 = await buildBatch(db, options);
		expect(batch1?.manifest.row_count).toBe(1);
		expect(batch1?.manifest.max_seq).toBe(earlySeq);

		releaseSlow();
		await heldSlow;
		await slow.close();

		// The one that matters: the lower seq is NOT stranded below the cursor.
		const batch2 = await buildBatch(db, options);
		expect(batch2?.manifest.row_count).toBe(1);
		expect(batch2?.manifest.min_seq).toBe(fastSeq);
	});
});
