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
import { seedGrant, seedRequest, seedRequester, seedRule } from '../setup/fixtures';

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

describe('the contract migration', () => {
	// The backfill's own assertion lived here until `all_request_tier` was
	// dropped; with the source column gone there is nothing left to compare the
	// tier rows against, and the migration that moved them has already run
	// everywhere this suite reaches.

	it('gives every grant a positive term', async () => {
		const rows = await db.execute<{ bad: number }>(sql`
			SELECT count(*)::int AS bad FROM access_grant
			WHERE term_days IS NULL OR term_days < 1`);
		expect(rows[0]?.bad).toBe(0);
	});

	it('has no scope flag columns left', async () => {
		const rows = await db.execute<{ column_name: string }>(sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name IN ('access_grant', 'access_request', 'access_rule')
			  AND column_name IN ('all_request_tier', 'max_tier')`);
		expect(rows).toEqual([]);
	});

	it('refuses a grant with no term', async () => {
		const requesterId = await seedRequester(db);
		await expect(
			db.execute(sql`
				INSERT INTO access_grant (requester_id, expires_at)
				VALUES (${requesterId}::uuid, now() + interval '30 days')`)
		).rejects.toThrow();
	});

	it('refuses a grant with a term of zero days', async () => {
		// NOT NULL alone would admit 0, which is a grant that expires the moment
		// it starts — the shape `GREATEST(1, ...)` exists in the backfill to avoid.
		const requesterId = await seedRequester(db);
		await expect(
			db.execute(sql`
				INSERT INTO access_grant (requester_id, expires_at, term_days)
				VALUES (${requesterId}::uuid, now() + interval '30 days', 0)`)
		).rejects.toThrow();
	});
});
