import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent } from '../../src/lib/server/db/schema';
import { queryEvents, recordEvent } from '../../src/lib/server/audit';

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

/**
 * The log is append-only, so a case cannot clean up after itself and the table
 * carries every row every other integration test has written. Each case tags
 * its own rows with a subject type nothing else uses and filters on it.
 */
function tag() {
	return `audit-query-${randomUUID()}`;
}

/** Inserts directly rather than through `recordEvent`, which has no `at`. */
async function recordAt(subjectType: string, action: string, at: Date) {
	await db.insert(auditEvent).values({ action, actorType: 'system', subjectType, at });
}

describe('queryEvents filtering', () => {
	it('filters by action', async () => {
		const subjectType = tag();
		const action = `audit-query.wanted.${randomUUID()}`;
		await recordEvent(db, { action, actor: { type: 'system', id: null }, subjectType });
		await recordEvent(db, {
			action: 'audit-query.unwanted',
			actor: { type: 'system', id: null },
			subjectType
		});

		const events = await queryEvents(db, { action });

		expect(events).toHaveLength(1);
		expect(events[0]?.subjectType).toBe(subjectType);
	});

	it('filters by actor type', async () => {
		const subjectType = tag();
		await recordEvent(db, {
			action: 'audit-query.by-staff',
			actor: { type: 'staff', id: randomUUID() },
			subjectType
		});
		await recordEvent(db, {
			action: 'audit-query.by-system',
			actor: { type: 'system', id: null },
			subjectType
		});

		const events = await queryEvents(db, { subjectType, actorType: 'system' });

		expect(events).toHaveLength(1);
		expect(events[0]?.action).toBe('audit-query.by-system');
	});

	it('excludes events outside the from/to window', async () => {
		const subjectType = tag();
		const centre = new Date('2026-06-15T12:00:00.000Z');
		const hours = (n: number) => new Date(centre.getTime() + n * 3_600_000);

		await recordAt(subjectType, 'audit-query.before', hours(-2));
		await recordAt(subjectType, 'audit-query.inside', centre);
		await recordAt(subjectType, 'audit-query.after', hours(2));

		const events = await queryEvents(db, { subjectType, from: hours(-1), to: hours(1) });

		expect(events.map((event) => event.action)).toEqual(['audit-query.inside']);
	});

	it('orders newest-first by seq, not by at', async () => {
		const subjectType = tag();
		// The row inserted FIRST carries the LATER timestamp, so ordering by `at`
		// would return it first. Only ordering by `seq` puts the row that was
		// actually appended last at the top.
		await recordAt(subjectType, 'audit-query.appended-first', new Date('2026-06-15T13:00:00.000Z'));
		await recordAt(subjectType, 'audit-query.appended-last', new Date('2026-06-15T11:00:00.000Z'));

		const events = await queryEvents(db, { subjectType });

		expect(events.map((event) => event.action)).toEqual([
			'audit-query.appended-last',
			'audit-query.appended-first'
		]);
	});

	it('pages on the seq cursor with no overlap and no gap', async () => {
		const subjectType = tag();
		for (let n = 0; n < 5; n += 1) {
			await recordEvent(db, {
				action: `audit-query.page.${n}`,
				actor: { type: 'system', id: null },
				subjectType
			});
		}

		const all = await queryEvents(db, { subjectType });
		expect(all).toHaveLength(5);

		const first = await queryEvents(db, { subjectType, limit: 2 });
		expect(first.map((event) => event.id)).toEqual(all.slice(0, 2).map((event) => event.id));

		const second = await queryEvents(db, {
			subjectType,
			limit: 2,
			beforeSeq: first.at(-1)!.seq
		});

		expect(second.map((event) => event.id)).toEqual(all.slice(2, 4).map((event) => event.id));
	});

	it('returns an empty array when nothing matches', async () => {
		expect(await queryEvents(db, { action: `audit-query.absent.${randomUUID()}` })).toEqual([]);
	});
});
