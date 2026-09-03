import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import {
	accessGrant,
	accessRequest,
	auditEvent,
	document,
	documentCategory,
	documentFile,
	documentTranslation,
	requester
} from '../../src/lib/server/db/schema';
import { enrichEvent } from '../../src/lib/server/egress/enrich';

let db: Db;
let close: () => Promise<void>;

const CONTEXT = {
	deliveryId: 'd1e5f2a0-0000-4000-8000-00000000000a',
	baseUrl: 'https://trust.example.com',
	locale: 'en'
};

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

async function newestEvent(action: string) {
	const [row] = await db
		.select()
		.from(auditEvent)
		.where(eq(auditEvent.action, action))
		.orderBy(sql`seq desc`)
		.limit(1);
	if (!row) throw new Error(`no ${action} event`);
	return row;
}

async function insertRequester(overrides: Record<string, unknown> = {}): Promise<string> {
	const [row] = await db
		.insert(requester)
		.values({
			email: `person-${crypto.randomUUID()}@acme.example`,
			name: 'Dana Vogel',
			company: 'Acme GmbH',
			companyDomain: 'acme.example',
			locale: 'en',
			...overrides
		})
		.returning({ id: requester.id });
	return row!.id;
}

/** document requires a category (NOT NULL FK), so every document fixture creates one. */
async function insertCategory(): Promise<string> {
	const [row] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${crypto.randomUUID()}` })
		.returning({ id: documentCategory.id });
	return row!.id;
}

describe('enrichEvent', () => {
	it('enriches access_request.pending from live domain state', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'pending' })
			.returning({ id: accessRequest.id });

		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id,
			ip: '198.51.100.7',
			ua: 'Mozilla/5.0',
			meta: { ruleId: null, domain: 'acme.example' }
		});

		const outcome = await enrichEvent(db, await newestEvent('access_request.pending'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(true);
		expect(outcome.model.data).toMatchObject({
			name: 'Dana Vogel',
			company: 'Acme GmbH',
			companyDomain: 'acme.example'
		});
		expect(outcome.model.data.email).toContain('@acme.example');
		expect(outcome.model.summary).toContain('Acme GmbH');
		expect(outcome.model.link).toBe(`https://trust.example.com/en/admin/requests/${request!.id}`);
		expect(outcome.model.seq).toBe(String(outcome.model.seq));
		// Forensic columns never travel.
		expect(JSON.stringify(outcome.model)).not.toContain('198.51.100.7');
		expect(JSON.stringify(outcome.model)).not.toContain('Mozilla');
	});

	/**
	 * A privacy feature must not cause a data-integrity failure. A consumer
	 * receiving `name: ""`, `email: ""` cannot distinguish it from a person
	 * with no name: n8n → HubSpot will create a junk contact, or error, or —
	 * worst — upsert by an empty email and overwrite an unrelated record.
	 * Blanks are the one shape a consumer cannot branch on (spec §4.5).
	 */
	it('skips an event whose requester has been purged', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'approved' })
			.returning({ id: accessRequest.id });
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id
		});

		// Exactly what purgeRequester writes — NOT blank columns. An
		// implementation testing for an empty email gets the one field a CRM
		// upserts on wrong.
		await db
			.update(requester)
			.set({
				email: `purged-${requesterId}@invalid`,
				name: '',
				company: '',
				companyDomain: '',
				purgedAt: new Date()
			})
			.where(eq(requester.id, requesterId));

		const outcome = await enrichEvent(db, await newestEvent('access_request.approved'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_purged' });
	});

	it('skips an event whose subject row is gone', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'pending' })
			.returning({ id: accessRequest.id });
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id
		});
		await db.delete(accessRequest).where(eq(accessRequest.id, request!.id));

		const outcome = await enrichEvent(db, await newestEvent('access_request.pending'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_missing' });
	});

	/**
	 * §6.6 guarantees `meta` holds no requester personal data, so the fallback
	 * is safe by construction rather than by filtering — which is worth
	 * preserving, because a filter is a thing somebody later forgets to extend.
	 */
	it('falls back to the audit row for an unregistered action', async () => {
		await recordEvent(db, {
			action: 'certification.created',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'certification',
			subjectId: crypto.randomUUID(),
			ip: '198.51.100.9',
			ua: 'curl/8',
			meta: { slug: 'iso-27001' }
		});

		const outcome = await enrichEvent(db, await newestEvent('certification.created'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toEqual({ slug: 'iso-27001' });
		expect(outcome.model.link).toBeNull();
		expect(JSON.stringify(outcome.model)).not.toContain('198.51.100.9');
		expect(JSON.stringify(outcome.model)).not.toContain('curl/8');
	});

	/**
	 * `access_request.submitted` takes the fallback path deliberately: at the
	 * moment it is written there is no requester row, and the name and address
	 * are free text from a public, unauthenticated form. Enriching it would
	 * make that form a delivery mechanism aimed at the operator's own staff
	 * channel and CRM (spec §4.3).
	 */
	it('does not enrich access_request.submitted', async () => {
		await recordEvent(db, {
			action: 'access_request.submitted',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID(),
			meta: { documentCount: 2, tiers: ['request'] }
		});

		const outcome = await enrichEvent(db, await newestEvent('access_request.submitted'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toEqual({ documentCount: 2, tiers: ['request'] });
	});

	/**
	 * Plan C5. `/api/documents/{fileId}` is the cookie-free public path, so
	 * this event is routinely written with a null actor id and no requester
	 * row. Treating that as a missing subject would silently drop every public
	 * download notification an operator subscribed to.
	 */
	it('delivers a public document.downloaded with no requester', async () => {
		const categoryId = await insertCategory();
		const [doc] = await db
			.insert(document)
			.values({ slug: `policy-${crypto.randomUUID()}`, categoryId, tier: 'public' })
			.returning({ id: document.id });
		await db
			.insert(documentTranslation)
			.values({ documentId: doc!.id, locale: 'en', title: 'Information Security Policy' });
		const [file] = await db
			.insert(documentFile)
			.values({
				documentId: doc!.id,
				locale: 'en',
				version: 1,
				storageKey: `k-${crypto.randomUUID()}`,
				filename: 'information-security-policy.pdf',
				contentType: 'application/pdf',
				sizeBytes: 1024,
				sha256: 'a'.repeat(64)
			})
			.returning({ id: documentFile.id });

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: null },
			subjectType: 'document_file',
			subjectId: file!.id,
			meta: { documentId: doc!.id, locale: 'en', version: 1, tier: 'public', watermarked: false }
		});

		const outcome = await enrichEvent(db, await newestEvent('document.downloaded'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.actor.id).toBeNull();
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toMatchObject({
			title: 'Information Security Policy',
			tier: 'public'
		});
		expect(outcome.model.data).not.toHaveProperty('email');
	});

	it('enriches a gated document.downloaded with the requester', async () => {
		const requesterId = await insertRequester({ name: 'Ines Roth', company: 'Beta AG' });
		const categoryId = await insertCategory();
		const [doc] = await db
			.insert(document)
			.values({ slug: `soc2-${crypto.randomUUID()}`, categoryId, tier: 'request' })
			.returning({ id: document.id });
		await db
			.insert(documentTranslation)
			.values({ documentId: doc!.id, locale: 'en', title: 'SOC 2' });
		const [file] = await db
			.insert(documentFile)
			.values({
				documentId: doc!.id,
				locale: 'en',
				version: 1,
				storageKey: `k-${crypto.randomUUID()}`,
				filename: 'soc2.pdf',
				contentType: 'application/pdf',
				sizeBytes: 2048,
				sha256: 'b'.repeat(64)
			})
			.returning({ id: documentFile.id });

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'document_file',
			subjectId: file!.id,
			meta: { documentId: doc!.id, locale: 'en', version: 1, tier: 'request', watermarked: true }
		});

		const outcome = await enrichEvent(db, await newestEvent('document.downloaded'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(true);
		expect(outcome.model.data).toMatchObject({
			name: 'Ines Roth',
			title: 'SOC 2',
			tier: 'request'
		});
	});

	it('skips a grant revocation whose grant is gone', async () => {
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: crypto.randomUUID()
		});

		const outcome = await enrichEvent(db, await newestEvent('access_grant.revoked'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_missing' });
	});

	it('enriches a grant revocation', async () => {
		const requesterId = await insertRequester({ name: 'Lior Kaplan' });
		const [grant] = await db
			.insert(accessGrant)
			.values({
				requesterId,
				termDays: 90,
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: accessGrant.id });

		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: grant!.id
		});

		const outcome = await enrichEvent(db, await newestEvent('access_grant.revoked'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.data).toMatchObject({ name: 'Lior Kaplan', grantId: grant!.id });
		expect(outcome.model.link).toBe('https://trust.example.com/en/admin/grants');
	});
});
