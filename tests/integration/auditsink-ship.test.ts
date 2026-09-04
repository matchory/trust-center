import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildBatch } from '../../src/lib/server/auditsink/reader';
import { claimShipments, rebuildBatch, shipClaimed } from '../../src/lib/server/auditsink/ship';
import { createDb } from '../../src/lib/server/db';
import { auditBatchShipment, staffUser } from '../../src/lib/server/db/schema';
import { purgeRequester } from '../../src/lib/server/purge';
import {
	alwaysFails,
	alwaysSucceeds,
	failingAfter,
	insertBatch,
	nullStorage,
	seedCursorAtHorizon,
	seedRequesterWithAuditEvent
} from '../helpers/auditsink';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let staffUserId: string;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL ?? '';
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [row] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `staff-${randomUUID()}@example.test`,
			name: 'Audit Sink Fixture',
			role: 'admin'
		})
		.returning({ id: staffUser.id });
	staffUserId = row!.id;
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// audit_batch and audit_batch_shipment refuse DELETE and TRUNCATE by design
	// (spec §2.1), so the fixture reset must cross that trigger explicitly, as
	// tests/integration/auditsink-reader.test.ts already does.
	await db.execute(sql`ALTER TABLE audit_batch DISABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment DISABLE TRIGGER USER`);
	await db.execute(sql`TRUNCATE TABLE audit_batch_shipment, audit_batch`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment ENABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch ENABLE TRIGGER USER`);
});

describe('claimShipments', () => {
	it('creates a row for every configured sink over every unshipped batch', async () => {
		await seedCursorAtHorizon(db);
		const batch = await insertBatch(db);

		const claimed = await claimShipments(db, ['s3'], 25);

		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.batchId).toBe(batch.id);
	});

	// RULING 2: the brief's unbounded INSERT … SELECT is fixed to scan only
	// batches that have no shipment row yet for the sink, ordered by cursor and
	// capped at the claim limit. The consequence is that a sink configured
	// later catches up at `limit` batches per call rather than all at once, so
	// this asserts catch-up over successive calls against a backlog larger than
	// the limit, rather than one call seeing the full history.
	it('gives a sink configured later the full history, catching up over successive calls', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);
		await insertBatch(db);
		await insertBatch(db);
		await claimShipments(db, ['s3'], 25);

		// syslog has never run; it must see all three batches, with no backfill
		// command — but bounded to 2 per call, so it takes two calls, not one.
		const first = await claimShipments(db, ['syslog'], 2);
		expect(first).toHaveLength(2);

		const second = await claimShipments(db, ['syslog'], 2);
		expect(second).toHaveLength(1);
	});

	it('does not re-claim within the stamp window', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);

		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(1);
		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(0);
	});

	it('bounds a large backlog by the claim limit', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 30; i++) await insertBatch(db);

		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(25);
	});

	it('claims in cursor order', async () => {
		await seedCursorAtHorizon(db);
		const first = await insertBatch(db);
		const second = await insertBatch(db);

		const claimed = await claimShipments(db, ['s3'], 25);
		expect(claimed.map((c) => c.batchId)).toEqual([first.id, second.id]);
	});
});

describe('shipClaimed', () => {
	it('records the shipped digest and stops the sink at the first failure', async () => {
		await seedCursorAtHorizon(db);
		const first = await insertBatch(db);
		const second = await insertBatch(db);
		const claimed = await claimShipments(db, ['s3'], 25);

		const adapter = failingAfter(1); // ships the first, throws on the second
		await shipClaimed(db, claimed, [adapter], new Map());

		const rows = await db.select().from(auditBatchShipment);
		const one = rows.find((r) => r.batchId === first.id)!;
		const two = rows.find((r) => r.batchId === second.id)!;

		expect(one.shippedAt).not.toBeNull();
		expect(one.digest).toHaveLength(64);
		expect(two.shippedAt).toBeNull();
		expect(two.attempts).toBe(1);
		expect(two.lastError).toBe('network');
	});

	it("leaves one sink's shipments intact when another fails", async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);
		const claimed = await claimShipments(db, ['s3', 'syslog'], 25);

		await shipClaimed(db, claimed, [alwaysFails('s3'), alwaysSucceeds('syslog')], new Map());

		const rows = await db.select().from(auditBatchShipment);
		expect(rows.find((r) => r.sink === 's3')!.shippedAt).toBeNull();
		expect(rows.find((r) => r.sink === 'syslog')!.shippedAt).not.toBeNull();
	});

	it('backs off exponentially without ever giving up', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);

		for (let attempt = 1; attempt <= 3; attempt++) {
			const claimed = await claimShipments(db, ['s3'], 25);
			if (claimed.length > 0) await shipClaimed(db, claimed, [alwaysFails('s3')], new Map());
			await db
				.update(auditBatchShipment)
				.set({ nextAttemptAt: new Date(Date.now() - 1000) })
				.where(eq(auditBatchShipment.sink, 's3'));
		}

		const [row] = await db.select().from(auditBatchShipment);
		expect(row!.attempts).toBe(3);
		expect(row!.shippedAt).toBeNull(); // never terminal — spec §2.2
	});
});

describe('rebuildBatch', () => {
	it('drops a purged row from the range, so the manifest disagrees on row_count', async () => {
		// Spec §4.3: purgeRequester's UPDATE bumps the row's xmin above every
		// batch cursor, so it leaves the half-open range entirely. This is the
		// mechanism the first draft got wrong, and it is what a digest mismatch
		// actually means.
		await seedCursorAtHorizon(db);
		const { requesterId } = await seedRequesterWithAuditEvent(db);
		const batch = await buildBatch(db, { batchRows: 1000, maxAgeMs: 0, maxBytes: 8e6 });
		expect(batch!.manifest.row_count).toBe(1);

		await purgeRequester(db, {
			requesterId,
			staffUserId,
			ip: null,
			storage: nullStorage
		});

		const rebuilt = await rebuildBatch(db, batch!.id);
		expect(rebuilt.manifest.row_count).toBe(0);
		expect(rebuilt.digest).not.toBe(batch!.digest);
	});
});
