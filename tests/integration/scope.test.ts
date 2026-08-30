import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGroup } from '../../src/lib/server/access/groups';
import {
	grantGroups,
	grantTiers,
	honouredTiers,
	requestTiers,
	ruleTiers,
	setGrantGroups,
	setGrantTiers,
	setRequestTiers,
	setRuleTiers
} from '../../src/lib/server/access/scope';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGroup,
	accessRequest,
	accessRule,
	requester
} from '../../src/lib/server/db/schema';
import { seedGrant, seedRequest, seedRule } from '../setup/fixtures';

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

describe('scope sets', () => {
	beforeEach(async () => {
		await db.delete(accessGrant);
		await db.delete(accessRequest);
		await db.delete(accessRule);
		await db.delete(accessGroup);
		await db.delete(requester);
	});

	it('round-trips a grant tier set', async () => {
		const grantId = await seedGrant(db);
		await setGrantTiers(db, grantId, ['request']);
		expect(await grantTiers(db, grantId)).toEqual(['request']);
	});

	it('replaces a tier set wholesale rather than adding to it', async () => {
		const grantId = await seedGrant(db);
		await setGrantTiers(db, grantId, ['request', 'nda']);
		await setGrantTiers(db, grantId, ['nda']);
		expect(await grantTiers(db, grantId)).toEqual(['nda']);
	});

	it('treats an empty set as "explicit documents only"', async () => {
		const grantId = await seedGrant(db);
		await setGrantTiers(db, grantId, ['request']);
		await setGrantTiers(db, grantId, []);
		expect(await grantTiers(db, grantId)).toEqual([]);
	});

	it('refuses a tier the database does not admit', async () => {
		const grantId = await seedGrant(db);
		// 'public' is meaningless in a grant scope: a public document needs no
		// grant, so admitting it would be a scope entry that grants nothing.
		await expect(setGrantTiers(db, grantId, ['public' as never])).rejects.toThrow();
	});

	it('round-trips a grant group set', async () => {
		const grantId = await seedGrant(db);
		const groupId = await createGroup(db, { slug: 'customer', position: 0 });
		await setGrantGroups(db, grantId, [groupId]);
		expect(await grantGroups(db, grantId)).toEqual([groupId]);
	});

	it('round-trips request and rule tier sets', async () => {
		const requestId = await seedRequest(db);
		const ruleId = await seedRule(db, { pattern: 'acme.example' });

		await setRequestTiers(db, requestId, ['request']);
		await setRuleTiers(db, ruleId, ['request', 'nda']);

		expect(await requestTiers(db, requestId)).toEqual(['request']);
		expect(await ruleTiers(db, ruleId)).toEqual(['nda', 'request']);
	});

	it('honours only the tiers this phase implements', () => {
		// The NDA tier is storable and not yet honoured. Phase 3b deletes this
		// filter; until then a rule naming it must not widen anything.
		expect(honouredTiers(['request', 'nda'])).toEqual(['request']);
		expect(honouredTiers(['nda'])).toEqual([]);
		expect(honouredTiers([])).toEqual([]);
	});
});

describe('scope backfill', () => {
	it('gives every pre-existing all-request-tier grant a request tier row', async () => {
		// The migration has already run against this database, so the assertion
		// is that no live grant lost its blanket in translation.
		const rows = await db.execute<{ mismatched: number }>(sql`
			SELECT count(*)::int AS mismatched
			FROM access_grant g
			WHERE g.all_request_tier
			  AND NOT EXISTS (
			    SELECT 1 FROM access_grant_tier t
			    WHERE t.grant_id = g.id AND t.tier = 'request'
			  )`);
		expect(rows[0]?.mismatched).toBe(0);
	});

	it('gives every pre-existing grant a positive term', async () => {
		const rows = await db.execute<{ bad: number }>(sql`
			SELECT count(*)::int AS bad FROM access_grant
			WHERE term_days IS NULL OR term_days < 1`);
		expect(rows[0]?.bad).toBe(0);
	});
});
