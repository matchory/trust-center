import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { eventDelivery, eventEndpoint } from '../../src/lib/server/db/schema';
import { currentHorizon } from '../../src/lib/server/egress/fanout';
import { sweepEventDeliveries } from '../../src/lib/server/retention';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	await db.delete(eventEndpoint);
});

describe('sweepEventDeliveries', () => {
	it('deletes terminal rows past the window and keeps pending ones', async () => {
		const horizon = await currentHorizon(db);
		const [endpoint] = await db
			.insert(eventEndpoint)
			.values({
				name: 'n8n',
				url: 'https://hooks.example.test/a',
				format: 'generic',
				cursorXmin: horizon,
				cursorSeq: 0n
			})
			.returning({ id: eventEndpoint.id });

		await db.execute(sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id, status, created_at) VALUES
				(${endpoint!.id}::uuid, 1, gen_random_uuid(), 'delivered', now() - interval '40 days'),
				(${endpoint!.id}::uuid, 2, gen_random_uuid(), 'failed',    now() - interval '40 days'),
				(${endpoint!.id}::uuid, 3, gen_random_uuid(), 'skipped',   now() - interval '40 days'),
				(${endpoint!.id}::uuid, 4, gen_random_uuid(), 'delivered', now() - interval '10 days'),
				-- A pending row is still owed a delivery, however old it is.
				(${endpoint!.id}::uuid, 5, gen_random_uuid(), 'pending',   now() - interval '40 days')
		`);

		const result = await sweepEventDeliveries(db, { retentionDays: 30 });

		expect(result.deleted).toBe(3);
		const remaining = await db
			.select({ auditSeq: eventDelivery.auditSeq })
			.from(eventDelivery)
			.where(eq(eventDelivery.endpointId, endpoint!.id))
			.orderBy(eventDelivery.auditSeq);
		expect(remaining.map((row) => String(row.auditSeq))).toEqual(['4', '5']);
	});
});
