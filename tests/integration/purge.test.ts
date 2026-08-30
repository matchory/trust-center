import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import { createDb } from '../../src/lib/server/db';
import {
	auditEvent,
	outboundEmail,
	requester,
	requesterSession,
	staffUser
} from '../../src/lib/server/db/schema';
import { createRequesterSession, upsertRequester } from '../../src/lib/server/identity/requester';
import { enqueueEmail } from '../../src/lib/server/mail/queue';
import { purgeRequester } from '../../src/lib/server/purge';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let staffUserId: string;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));

	const [row] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `staff-${randomUUID()}@example.test`,
			name: 'Purge Fixture',
			role: 'admin'
		})
		.returning({ id: staffUser.id });

	staffUserId = row!.id;
});

afterAll(async () => {
	await close();
});

async function person(): Promise<{ id: string; email: string }> {
	const email = `person-${randomUUID()}@acme.example`;
	const row = await upsertRequester(db, { email, name: 'A Person', company: 'Acme', locale: 'de' });
	return { id: row.id, email };
}

describe('purgeRequester', () => {
	it('blanks the personal columns but keeps the row', async () => {
		const { id } = await person();

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null });

		const [after] = await db.select().from(requester).where(eq(requester.id, id));
		// The row survives so grants and requests keep referential integrity;
		// only the identifying columns go.
		expect(after).toBeDefined();
		expect(after!.purgedAt).not.toBeNull();
		expect(after!.email).not.toContain('acme.example');
		expect(after!.name).toBe('');
		expect(after!.company).toBe('');
		expect(after!.companyDomain).toBe('');
	});

	it('pseudonymizes the requester audit events without deleting them', async () => {
		const { id } = await person();

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id },
			subjectType: 'document_file',
			subjectId: randomUUID(),
			ip: '203.0.113.5',
			ua: 'Mozilla/5.0'
		});

		const before = await db.select().from(auditEvent).where(eq(auditEvent.actorId, id));
		expect(before).toHaveLength(1);

		const result = await purgeRequester(db, { requesterId: id, staffUserId, ip: null });
		expect(result.eventsPseudonymized).toBe(1);

		// The occurrence survives; the link to the person does not.
		const [event] = await db.select().from(auditEvent).where(eq(auditEvent.id, before[0]!.id));

		expect(event).toBeDefined();
		expect(event!.action).toBe('document.downloaded');
		expect(event!.actorId).toBeNull();
		expect(event!.ip).toBeNull();
		expect(event!.ua).toBeNull();
	});

	it('writes its own audit event, as spec §10 requires', async () => {
		const { id } = await person();

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null });

		const events = await db
			.select()
			.from(auditEvent)
			.where(and(eq(auditEvent.action, 'requester.purged'), eq(auditEvent.subjectId, id)));

		expect(events).toHaveLength(1);
		// Staff are outside the requester purge and may be named.
		expect(events[0]!.actorId).toBe(staffUserId);
	});

	it('revokes every session and clears queued mail', async () => {
		const { id, email } = await person();
		await createRequesterSession(db, { requesterId: id, ttlHours: 24 });
		await enqueueEmail(db, {
			to: email,
			template: 'request_approved',
			locale: 'de',
			payload: { url: 'https://example.test' }
		});

		const [queued] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, email));
		expect(queued).toBeDefined();

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null });

		const revoked = await db
			.select()
			.from(requesterSession)
			.where(and(eq(requesterSession.requesterId, id), isNotNull(requesterSession.revokedAt)));

		expect(revoked.length).toBeGreaterThan(0);

		// The row stays — that a notification was queued is a fact about the
		// system — but the address goes, and the pending send is stopped so a
		// purge cannot mail a person who asked to be forgotten.
		expect(await db.select().from(outboundEmail).where(eq(outboundEmail.to, email))).toHaveLength(
			0
		);

		const [mail] = await db.select().from(outboundEmail).where(eq(outboundEmail.id, queued!.id));
		expect(mail).toBeDefined();
		expect(mail!.to).toBe('');
		expect(mail!.status).toBe('failed');
	});

	it('cannot be used to delete an audit event', async () => {
		// The trigger Phase 1 installed is what makes this true. Assert it here,
		// because purge is the only code path that touches audit_event with
		// anything but INSERT, and a widened UPDATE would be silent.
		await expect(db.delete(auditEvent)).rejects.toThrow();
	});
});
