import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import { createDb } from '../../src/lib/server/db';
import {
	auditEvent,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	outboundEmail,
	requester,
	requesterSession,
	staffUser
} from '../../src/lib/server/db/schema';
import { createRequesterSession, upsertRequester } from '../../src/lib/server/identity/requester';
import { enqueueEmail } from '../../src/lib/server/mail/queue';
import { recordAcceptance, validAcceptance } from '../../src/lib/server/nda/acceptance';
import { storeRecord } from '../../src/lib/server/nda/record';
import { purgeRequester } from '../../src/lib/server/purge';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import { seedAgreement, seedRule } from '../setup/fixtures';
import type { Db } from '../../src/lib/server/db';
import type { StorageAdapter } from '../../src/lib/server/storage';

const LOCALES = ['de', 'en'];

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

/** The cases above own no stored objects; this stands in where one is required. */
const noStorage = createLocalStorage('./data/storage');

describe('purgeRequester', () => {
	it('blanks the personal columns but keeps the row', async () => {
		const { id } = await person();

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null, storage: noStorage });

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

		const result = await purgeRequester(db, {
			requesterId: id,
			staffUserId,
			ip: null,
			storage: noStorage
		});
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

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null, storage: noStorage });

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

		await purgeRequester(db, { requesterId: id, staffUserId, ip: null, storage: noStorage });

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

describe('purging a signatory', () => {
	let storage: StorageAdapter;
	let requesterId: string;
	let colleagueId: string;
	let email: string;
	let templateId: string;
	let versionId: string;
	let bodySha: string;
	let acceptanceId: string;
	let recordKey: string;
	let attachmentKey: string;

	beforeEach(async () => {
		storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'purge-record-')));

		await db.delete(ndaAcceptance);
		await db.delete(ndaTemplateVersion);
		await db.delete(ndaTemplate);

		({
			templateId,
			versionId,
			sha256: bodySha
		} = await seedAgreement(db, {
			slug: `mutual-${randomUUID().slice(0, 8)}`,
			locales: LOCALES
		}));

		email = `signatory-${randomUUID()}@acme.example`;
		const signatory = await upsertRequester(db, {
			email,
			name: 'Łukasz Nowak',
			company: 'Acme GmbH',
			locale: 'en'
		});
		requesterId = signatory.id;

		const colleague = await upsertRequester(db, {
			email: `colleague-${randomUUID()}@acme.example`,
			name: 'A Colleague',
			company: 'Acme GmbH',
			locale: 'en'
		});
		colleagueId = colleague.id;

		// A domain the rules deliberately admit: `validAcceptance` refuses a
		// domain-scoped acceptance for anything an auto_approve rule does not match.
		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: ['request'] });

		({ acceptanceId } = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'Łukasz Nowak',
			sha256: bodySha,
			ip: '203.0.113.9',
			ua: 'test',
			locales: LOCALES
		}));

		recordKey = await storeRecord(
			db,
			storage,
			acceptanceId,
			new TextEncoder().encode('%PDF-1.7 record')
		);

		attachmentKey = newStorageKey();
		await storage.put(attachmentKey, new TextEncoder().encode('%PDF-1.7 copy'));
		await enqueueEmail(db, {
			to: email,
			template: 'nda_record',
			locale: 'en',
			payload: {
				agreement: 'Mutual NDA',
				attachments: [
					{ filename: 'acceptance.pdf', contentType: 'application/pdf', storageKey: attachmentKey }
				]
			}
		});
	});

	it('blanks the payload of every mail naming this person, not only the address', async () => {
		// purgeRequester blanked only `to`; payloads are cleared by
		// redactDeliveredMail after mailRetentionDays, an unrelated window. This
		// phase adds the highest-value payload in the system to that gap.
		await purgeRequester(db, { requesterId, staffUserId, ip: null, storage });

		const rows = await db.select().from(outboundEmail).where(eq(outboundEmail.to, ''));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => Object.keys(row.payload as object).length === 0)).toBe(true);
	});

	it('deletes the record object and nulls the column naming it', async () => {
		// The rendering names the person in full and in richer form than any
		// column, and storage was untouched by the purge.
		await purgeRequester(db, { requesterId, staffUserId, ip: null, storage });

		const [row] = await db.select().from(ndaAcceptance).where(eq(ndaAcceptance.id, acceptanceId));
		expect(row?.recordPdfKey).toBeNull();
		expect(await storage.stat(recordKey)).toBeNull();
	});

	it('leaves the acceptance identity fields intact', async () => {
		// Art. 6(1)(b)/(f) with the 17(3)(e) exemption. Either the record identifies
		// the counterparty or it should not be retained — pseudonymising these
		// leaves a record saying somebody once typed a name, which is the same as
		// not keeping it.
		await purgeRequester(db, { requesterId, staffUserId, ip: null, storage });

		const [row] = await db.select().from(ndaAcceptance).where(eq(ndaAcceptance.id, acceptanceId));
		expect(row?.typedName).toBe('Łukasz Nowak');
		expect(row?.email).toBe(email);
		expect(row?.company).toBe('Acme GmbH');
		expect(row?.companyDomain).toBe('acme.example');
		expect(row?.templateSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.ip).not.toBeNull();
	});

	it('keeps a domain-scoped colleague covered after one signatory is purged', async () => {
		// Purging the one colleague who signed must not revoke coverage for everyone
		// else at that company — which is the second reason company_domain is
		// denormalized onto the acceptance.
		await purgeRequester(db, { requesterId, staffUserId, ip: null, storage });

		expect(
			await validAcceptance(db, {
				requesterId: colleagueId,
				companyDomain: 'acme.example',
				templateId,
				scope: 'domain',
				locales: LOCALES
			})
		).not.toBeNull();
	});
});
