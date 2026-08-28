import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../../src/lib/server/db';

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

describe('setting table', () => {
	it('round-trips a jsonb value', async () => {
		await db.insert(schema.setting).values({ key: 'branding', value: { primary: '#0b3d2e' } });

		const rows = await db.select().from(schema.setting).where(eq(schema.setting.key, 'branding'));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toEqual({ primary: '#0b3d2e' });
	});

	it('rejects a duplicate key', async () => {
		await db.insert(schema.setting).values({ key: 'locales', value: ['de', 'en'] });

		await expect(
			db.insert(schema.setting).values({ key: 'locales', value: ['fr'] })
		).rejects.toThrow();
	});
});
