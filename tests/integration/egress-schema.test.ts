import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { eventEndpoint } from '../../src/lib/server/db/schema';
import { rejectionCause } from '../helpers/db';

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

/** A minimal valid endpoint. The cursor is the one column with no default. */
async function insertEndpoint(overrides: Record<string, unknown> = {}): Promise<string> {
	const [row] = await db
		.insert(eventEndpoint)
		.values({
			name: 'Teams',
			url: 'https://hooks.example.test/abc',
			format: 'teams',
			cursorXmin: 1000n,
			cursorSeq: 0n,
			...overrides
		})
		.returning({ id: eventEndpoint.id });
	return row!.id;
}

describe('event_endpoint', () => {
	it('accepts a valid row and defaults it to enabled', async () => {
		const id = await insertEndpoint();
		const [row] = await db
			.select()
			.from(eventEndpoint)
			.where(sql`id = ${id}::uuid`);

		expect(row?.enabled).toBe(true);
		expect(row?.disabledAt).toBeNull();
		expect(row?.lastSuccessAt).toBeNull();
	});

	it('rejects a format outside the registry', async () => {
		const message = await rejectionCause(insertEndpoint({ format: 'slack' }));
		expect(message).toContain('event_endpoint_format_check');
	});

	// The state lives in two columns, so the constraint says they agree — the
	// shape subscription's five confirmation columns use.
	it('rejects enabled = false without a disabled_at', async () => {
		const message = await rejectionCause(insertEndpoint({ enabled: false }));
		expect(message).toContain('event_endpoint_disabled_check');
	});

	it('rejects enabled = true with a disabled_at', async () => {
		const message = await rejectionCause(insertEndpoint({ disabledAt: new Date() }));
		expect(message).toContain('event_endpoint_disabled_check');
	});
});

describe('event_endpoint_filter', () => {
	it('cascades from the endpoint', async () => {
		const id = await insertEndpoint();
		await db.execute(
			sql`INSERT INTO event_endpoint_filter (endpoint_id, pattern) VALUES (${id}::uuid, 'access_request.*')`
		);

		await db.execute(sql`DELETE FROM event_endpoint WHERE id = ${id}::uuid`);

		const rows = (await db.execute(
			sql`SELECT count(*)::int AS n FROM event_endpoint_filter WHERE endpoint_id = ${id}::uuid`
		)) as unknown as { n: number }[];
		expect(rows[0]?.n).toBe(0);
	});
});

describe('event_delivery', () => {
	it('makes a second fan-out of the same event a no-op', async () => {
		const endpointId = await insertEndpoint();
		const insert = sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id)
			VALUES (${endpointId}::uuid, 4711, gen_random_uuid())
			ON CONFLICT (endpoint_id, audit_seq) DO NOTHING
		`;

		await db.execute(insert);
		await db.execute(insert);

		const rows = (await db.execute(
			sql`SELECT count(*)::int AS n FROM event_delivery WHERE endpoint_id = ${endpointId}::uuid`
		)) as unknown as { n: number }[];
		expect(rows[0]?.n).toBe(1);
	});

	it('rejects a status outside the closed set', async () => {
		const endpointId = await insertEndpoint();
		const message = await rejectionCause(
			db.execute(sql`
				INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id, status)
				VALUES (${endpointId}::uuid, 99, gen_random_uuid(), 'sent')
			`)
		);
		expect(message).toContain('event_delivery_status_check');
	});
});
