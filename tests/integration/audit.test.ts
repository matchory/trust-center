import { eq, sql } from 'drizzle-orm';
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
 * Drizzle wraps driver errors: `message` is only `Failed query: <sql> params: …`,
 * so asserting on it matches the statement text rather than the database's
 * complaint — and passes whenever the phrase happens to appear in the SQL or a
 * bound parameter. The Postgres message is on `cause`.
 */
async function rejectionCause(query: PromiseLike<unknown>): Promise<string> {
	try {
		await query;
	} catch (error) {
		const wrapped = error as Error & { cause?: Error };
		return wrapped.cause?.message ?? wrapped.message;
	}
	throw new Error('expected the query to be rejected, but it succeeded');
}

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

	it('rejects deletion at the database — audit_event is append-only', async () => {
		await recordEvent(db, {
			action: 'test.append-only-guard',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: 'append-only-guard'
		});

		expect(
			await rejectionCause(
				db.delete(auditEvent).where(eq(auditEvent.subjectId, 'append-only-guard'))
			)
		).toMatch(/append-only/);
	});

	it('permits clearing ip, ua and actor_id — the one pseudonymization exception', async () => {
		await recordEvent(db, {
			action: 'test.pseudonymize',
			actor: { type: 'requester', id: 'req-purge-me' },
			subjectType: 'test',
			subjectId: 'pseudonymize-allowed',
			ip: '198.51.100.7',
			ua: 'Mozilla/5.0'
		});

		await db
			.update(auditEvent)
			.set({ ip: null, ua: null, actorId: null })
			.where(eq(auditEvent.subjectId, 'pseudonymize-allowed'));

		const [row] = await queryEvents(db, {
			subjectType: 'test',
			subjectId: 'pseudonymize-allowed'
		});

		expect(row?.ip).toBeNull();
		expect(row?.ua).toBeNull();
		expect(row?.actorId).toBeNull();
		// The occurrence itself survives the purge — that is the whole point of
		// pseudonymizing rather than deleting.
		expect(row?.action).toBe('test.pseudonymize');
	});

	it('rejects rewriting ip to a different value rather than clearing it', async () => {
		await recordEvent(db, {
			action: 'test.pseudonymize',
			actor: { type: 'requester', id: 'req-2' },
			subjectType: 'test',
			subjectId: 'pseudonymize-rewrite',
			ip: '198.51.100.7'
		});

		expect(
			await rejectionCause(
				db
					.update(auditEvent)
					.set({ ip: '203.0.113.9' })
					.where(eq(auditEvent.subjectId, 'pseudonymize-rewrite'))
			)
		).toMatch(/never rewrite/);
	});

	it('rejects changing any column outside the pseudonymization set', async () => {
		await recordEvent(db, {
			action: 'test.immutable',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: 'immutable-action'
		});

		expect(
			await rejectionCause(
				db
					.update(auditEvent)
					.set({ action: 'test.rewritten' })
					.where(eq(auditEvent.subjectId, 'immutable-action'))
			)
		).toMatch(/append-only/);
	});

	it('rejects redacting meta, which must never hold requester personal data', async () => {
		await recordEvent(db, {
			action: 'test.meta-immutable',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: 'meta-immutable',
			meta: { documentId: 'doc-1' }
		});

		expect(
			await rejectionCause(
				db.update(auditEvent).set({ meta: {} }).where(eq(auditEvent.subjectId, 'meta-immutable'))
			)
		).toMatch(/append-only/);
	});

	it('rejects truncation, which row-level delete triggers do not catch', async () => {
		expect(await rejectionCause(db.execute(sql`TRUNCATE TABLE "audit_event"`))).toMatch(
			/cannot be truncated/
		);
	});

	it('rejects an actor_type outside the four the application defines', async () => {
		expect(
			await rejectionCause(
				db.execute(
					sql`INSERT INTO "audit_event" ("actor_type", "action") VALUES ('anonymous', 'test.bad-actor')`
				)
			)
		).toMatch(/actor_type/);
	});
});
