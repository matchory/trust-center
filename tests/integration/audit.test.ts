import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
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

describe('audit log', () => {
	it('records an event and reads it back by subject', async () => {
		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: 'req-1' },
			subjectType: 'document',
			subjectId: 'doc-42',
			ip: '198.51.100.7',
			meta: { version: 3 }
		});

		const events = await queryEvents(db, { subjectType: 'document', subjectId: 'doc-42' });

		expect(events).toHaveLength(1);
		expect(events[0]?.action).toBe('document.downloaded');
		expect(events[0]?.actorId).toBe('req-1');
		expect(events[0]?.meta).toEqual({ version: 3 });
		expect(events[0]?.at).toBeInstanceOf(Date);
	});

	it('accepts a system actor without an id', async () => {
		await recordEvent(db, {
			action: 'grant.expired',
			actor: { type: 'system', id: null },
			subjectType: 'grant',
			subjectId: 'grant-9'
		});

		const events = await queryEvents(db, { subjectType: 'grant', subjectId: 'grant-9' });

		expect(events[0]?.actorType).toBe('system');
		expect(events[0]?.actorId).toBeNull();
	});

	it('returns events newest first and honours the limit', async () => {
		for (const n of [1, 2, 3]) {
			await recordEvent(db, {
				action: `staff.login.${n}`,
				actor: { type: 'staff', id: 'staff-ordering' },
				subjectType: 'staff',
				subjectId: 'ordering'
			});
		}

		const events = await queryEvents(db, { subjectType: 'staff', subjectId: 'ordering', limit: 2 });

		expect(events).toHaveLength(2);
		expect(events[0]?.action).toBe('staff.login.3');
		expect(events[1]?.action).toBe('staff.login.2');
	});
});
