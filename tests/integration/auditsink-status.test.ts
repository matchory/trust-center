import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import { createDb } from '../../src/lib/server/db';
import { auditBatch, auditBatchShipment } from '../../src/lib/server/db/schema';
import { insertBatch, seedCursorAtHorizon } from '../helpers/auditsink';
import type { Db } from '../../src/lib/server/db';

/**
 * `auditSinkStatus` reads `getConfig()` to decide which sinks are configured,
 * and the integration suite runs with no application environment — the same
 * reason `egress-switch.test.ts` mocks it rather than building one.
 */
const s3Configured = vi.fn(() => true);

vi.mock('../../src/lib/server/config', () => ({
	getConfig: () => ({
		auditSink: {
			enabled: true,
			s3: s3Configured()
				? {
						bucket: 'audit',
						region: 'eu-central-1',
						// Nothing is listening: the probe must degrade to `unknown`
						// rather than making a page render wait on a dead host.
						endpoint: 'http://127.0.0.1:1',
						accessKeyId: 'k',
						secretAccessKey: 's'
					}
				: undefined
		}
	})
}));

const { auditSinkStatus } = await import('../../src/lib/server/auditsink/status');
const { resetObjectLockProbes } = await import('../../src/lib/server/auditsink/s3');

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL ?? '';
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Both tables refuse DELETE and TRUNCATE by design (spec §2.1), so the
	// fixture reset crosses the trigger explicitly, as the sibling suites do.
	await db.execute(sql`ALTER TABLE audit_batch DISABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment DISABLE TRIGGER USER`);
	await db.execute(sql`TRUNCATE TABLE audit_batch_shipment, audit_batch`);
	await db.execute(sql`ALTER TABLE audit_batch_shipment ENABLE TRIGGER USER`);
	await db.execute(sql`ALTER TABLE audit_batch ENABLE TRIGGER USER`);

	s3Configured.mockReturnValue(true);
	resetObjectLockProbes();
	vi.clearAllMocks();
});

describe('auditSinkStatus', () => {
	it('reports coverage as a comparison, not a keyset re-scan', async () => {
		// Spec §10: "rows not yet batched" from the keyset would be an
		// unindexable sequential scan per render, and would read zero in exactly
		// the two cases that matter — a forged cursor, and a period when the
		// sink was off.
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.coverage' });

		const status = await auditSinkStatus(db);

		expect(Number(status.coverage.eventMaxSeq)).toBeGreaterThan(
			Number(status.coverage.batchedMaxSeq)
		);
		expect(status.coverage.eventCount).toBeGreaterThan(0);
	});

	it('counts a batch nobody has claimed yet as pending', async () => {
		// The failure this guards: counting shipment rows would report a growing
		// backlog as zero, because an unclaimed batch has no shipment row.
		await seedCursorAtHorizon(db);
		await insertBatch(db);

		const s3 = (await auditSinkStatus(db)).sinks.find((sink) => sink.name === 's3')!;

		expect(s3.pending).toBe(1);
		expect(s3.oldestPendingAt).toBeInstanceOf(Date);
	});

	it('stops counting a batch once it has shipped', async () => {
		await seedCursorAtHorizon(db);
		const batch = await insertBatch(db);
		await db
			.insert(auditBatchShipment)
			.values({ batchId: batch.id, sink: 's3', shippedAt: new Date(), digest: 'x'.repeat(64) });

		const s3 = (await auditSinkStatus(db)).sinks.find((sink) => sink.name === 's3')!;

		expect(s3.pending).toBe(0);
		expect(s3.oldestPendingAt).toBeNull();
		expect(s3.lastShippedAt).toBeInstanceOf(Date);
	});

	it('counts a shipped digest that disagrees with the batch as a mismatch', async () => {
		// §4.3: expected after a purge, not alarming — but it must be visible on
		// a deployment with no metrics collector, which is most of them.
		await seedCursorAtHorizon(db);
		const same = await insertBatch(db);
		const differs = await insertBatch(db);
		const [recorded] = await db
			.select({ digest: auditBatch.digest })
			.from(auditBatch)
			.where(eq(auditBatch.id, same.id));

		await db.insert(auditBatchShipment).values([
			{ batchId: same.id, sink: 's3', shippedAt: new Date(), digest: recorded!.digest },
			{ batchId: differs.id, sink: 's3', shippedAt: new Date(), digest: 'y'.repeat(64) }
		]);

		const s3 = (await auditSinkStatus(db)).sinks.find((sink) => sink.name === 's3')!;

		expect(s3.digestMismatches).toBe(1);
	});

	it('reports only an error a sink is still carrying', async () => {
		await seedCursorAtHorizon(db);
		const failing = await insertBatch(db);
		const recovered = await insertBatch(db);

		await db.insert(auditBatchShipment).values([
			{ batchId: failing.id, sink: 's3', lastError: 'network', attempts: 2 },
			{
				// Shipped despite an earlier failure: history, not a current fault.
				batchId: recovered.id,
				sink: 's3',
				lastError: null,
				shippedAt: new Date(),
				digest: 'z'.repeat(64)
			}
		]);

		const s3 = (await auditSinkStatus(db)).sinks.find((sink) => sink.name === 's3')!;

		expect(s3.lastError).toEqual({ reason: 'network', statusCode: null });
	});

	it('degrades the object-lock status to unknown when the bucket cannot be asked', async () => {
		const s3 = (await auditSinkStatus(db)).sinks.find((sink) => sink.name === 's3')!;

		expect(s3.objectLock).toBe('unknown');
	});

	it('reports a sink that is not configured, rather than hiding it', async () => {
		s3Configured.mockReturnValue(false);

		const status = await auditSinkStatus(db);

		expect(status.sinks.map((sink) => sink.name)).toContain('syslog');
		expect(status.sinks.find((sink) => sink.name === 's3')!.configured).toBe(false);
		expect(status.sinks.find((sink) => sink.name === 's3')!.objectLock).toBeNull();
	});

	it('reports a fresh deployment as zero rather than throwing', async () => {
		const status = await auditSinkStatus(db);

		expect(status.coverage.batchCount).toBe(0);
		expect(status.coverage.batchedMaxSeq).toBe('0');
		expect(status.coverage.lastBatchAt).toBeNull();
		expect(status.sinks.every((sink) => sink.pending === 0)).toBe(true);
	});
});
