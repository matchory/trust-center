import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import {
	attestationDue,
	buildAttestation,
	markAttested
} from '../../src/lib/server/auditsink/attest';
import { buildBatch } from '../../src/lib/server/auditsink/reader';
import { claimShipments, rebuildBatch, shipClaimed } from '../../src/lib/server/auditsink/ship';
import { buildManifest } from '../../src/lib/server/auditsink/serialize';
import { createDb } from '../../src/lib/server/db';
import { auditBatch, auditBatchShipment, staffUser } from '../../src/lib/server/db/schema';
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

	// Finding 12: the "is due when none has been written" test below only
	// passed because it happened to run before the first markAttested in this
	// file — clear the mark so every test starts from the same "never marked"
	// state regardless of run order.
	await db.execute(sql`DELETE FROM setting WHERE key = 'auditsink.attested_at'`);
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

	// Review finding (fix round 1): the rebuildBatch call in shipClaimed's loop
	// used to sit outside the try/catch, so any failure other than a clean
	// SinkError from ship() escaped classifyError, the attempts bump, and the
	// backoff write, and rejected the whole adapter's Promise.all entry — the
	// exact shape of spec §18's issue, which subsystem A already shipped and
	// fixed once. This proves the guard: a batch outside `prebuilt` forces a
	// rebuild, and the db handle's `select` always throws for it, standing in
	// for "rebuildBatch fails for any reason" — while a sibling batch supplied
	// through `prebuilt` (so it never calls rebuildBatch, and never touches the
	// stubbed method) still ships in the same call.
	it('catches a rebuildBatch failure through the same path as a ship failure, without losing a sibling shipment', async () => {
		await seedCursorAtHorizon(db);
		const healthy = await insertBatch(db);
		const broken = await insertBatch(db);
		const claimed = await claimShipments(db, ['s3'], 25);

		const digest = 'a'.repeat(64);
		const prebuilt = new Map([
			[
				healthy.id,
				{
					id: healthy.id,
					body: new Uint8Array(),
					digest,
					manifest: buildManifest({
						id: healthy.id,
						createdAt: new Date().toISOString(),
						prevCursor: { xmin: 0n, seq: 0n },
						cursor: { xmin: 1n, seq: 1n },
						rowCount: 0,
						minSeq: 0n,
						maxSeq: 0n,
						byteCount: 0,
						digest
					})
				}
			]
		]);

		// select() always throws; update() is left alone so the catch block's
		// own write still lands. The healthy shipment is served from `prebuilt`
		// and so never calls select() at all.
		const dbWithBrokenRebuild = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'select') {
					return () => {
						throw new Error('stubbed: select is unavailable');
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		});

		await expect(
			shipClaimed(dbWithBrokenRebuild, claimed, [alwaysSucceeds('s3')], prebuilt)
		).resolves.toBeUndefined();

		const rows = await db.select().from(auditBatchShipment);
		const healthyRow = rows.find((r) => r.batchId === healthy.id)!;
		const brokenRow = rows.find((r) => r.batchId === broken.id)!;

		expect(healthyRow.shippedAt).not.toBeNull();

		// (b) — the point of this test: the failure is recorded, not swallowed
		// by an unhandled rejection.
		expect(brokenRow.shippedAt).toBeNull();
		expect(brokenRow.attempts).toBe(1);
		expect(brokenRow.lastError).toBe('network');
		expect(brokenRow.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
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
	// Finding 2: §4.3's two-digest design rests on same-tick digests being
	// identical by construction, so a recorded mismatch means a genuine
	// erasure. If the range predicate were systematically wrong, every
	// later-tick retry (with nothing purged) would record a false mismatch,
	// and only this assertion — not the purge test below — would catch it.
	it('reproduces the same digest and row_count with no purge in between', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 3; i++) {
			await recordEvent(db, { actor: { type: 'system', id: null }, action: `test.rebuild.${i}` });
		}
		const batch = await buildBatch(db, { batchRows: 1000, maxAgeMs: 0, maxBytes: 8e6 });

		const rebuilt = await rebuildBatch(db, batch!.id);

		expect(rebuilt.digest).toBe(batch!.digest);
		expect(rebuilt.manifest.row_count).toBe(batch!.manifest.row_count);
	});

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

describe('attestation', () => {
	it('reports the log height and the cursor together', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system', id: null }, action: 'test.attest' });

		const attestation = await buildAttestation(db);

		const [row] = (await db.execute(
			sql`SELECT count(*)::text AS c, coalesce(max(seq), 0)::text AS m FROM audit_event`
		)) as unknown as { c: string; m: string }[];

		const [head] = await db
			.select({ id: auditBatch.id, seq: auditBatch.cursorSeq })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1);

		expect(attestation.event_count).toBe(row!.c);
		expect(attestation.max_seq).toBe(row!.m);
		expect(attestation.cursor.seq).toBe(String(head!.seq));
		// Finding 10: last_batch_id and batches_since went unasserted, which is
		// why finding 1 (max(id::text) instead of the true most-recent batch)
		// survived review. seedCursorAtHorizon is the only batch in this test,
		// and the setting was never marked, so it must be named and counted.
		expect(attestation.last_batch_id).toBe(head!.id);
		expect(attestation.batches_since).toBe(1);
	});

	// Finding 1, as a direct reproduction: three batches inserted out of UUID
	// lexicographic order must still name the cursor-order head, not
	// whichever id happens to sort last as text.
	it('names the cursor-order head as last_batch_id, not the lexicographic max id', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);
		await insertBatch(db);
		const last = await insertBatch(db);

		const attestation = await buildAttestation(db);

		expect(attestation.last_batch_id).toBe(last.id);
	});

	it('is due when none has been written within the interval', async () => {
		expect(await attestationDue(db, 24 * 60 * 60_000)).toBe(true);
	});

	// The round trip below is the coverage that matters: `setting.value` is
	// jsonb, so a bare-string write or a `value::timestamptz` read both fail
	// at runtime, and neither is caught unless something writes and reads the
	// same row back. Read findings, fix round 1.
	it('is not due right after marking, for an interval comfortably longer than the elapsed time', async () => {
		await markAttested(db, new Date());
		expect(await attestationDue(db, 24 * 60 * 60_000)).toBe(false);
	});

	it("stores the mark as a value that round-trips through the same #>> '{}' extraction attestationDue uses", async () => {
		const at = new Date('2026-01-01T00:00:00.000Z');
		await markAttested(db, at);

		const [row] = (await db.execute(
			sql`SELECT value #>> '{}' AS value FROM setting WHERE key = 'auditsink.attested_at'`
		)) as unknown as { value: string }[];

		expect(new Date(row!.value).getTime()).toBe(at.getTime());
	});

	it('updates the existing row on a second mark rather than inserting a duplicate', async () => {
		await markAttested(db, new Date('2026-01-01T00:00:00.000Z'));
		await markAttested(db, new Date('2026-01-02T00:00:00.000Z'));

		const rows = (await db.execute(
			sql`SELECT value #>> '{}' AS value FROM setting WHERE key = 'auditsink.attested_at'`
		)) as unknown as { value: string }[];

		expect(rows).toHaveLength(1);
		expect(new Date(rows[0]!.value).getTime()).toBe(new Date('2026-01-02T00:00:00.000Z').getTime());
	});

	it('is due again once the interval has elapsed since the mark', async () => {
		await markAttested(db, new Date());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await attestationDue(db, 1)).toBe(true);
	});
});
