import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import {
	accessRequest,
	accessRequestDocument,
	document,
	documentCategory,
	documentTranslation,
	magicLink
} from '../../src/lib/server/db/schema';
import {
	requestableDocuments,
	RequestRejected,
	submitRequest
} from '../../src/lib/server/access/requests';
import { requestTiers } from '../../src/lib/server/access/scope';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let requestTierId: string;
let ndaTierId: string;
let publicTierId: string;
let draftRequestTierId: string;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${randomUUID()}` })
		.returning();

	const inserted = await db
		.insert(document)
		.values([
			{
				slug: `req-${randomUUID()}`,
				categoryId: category!.id,
				tier: 'request',
				status: 'published'
			},
			{ slug: `nda-${randomUUID()}`, categoryId: category!.id, tier: 'nda', status: 'published' },
			{
				slug: `pub-${randomUUID()}`,
				categoryId: category!.id,
				tier: 'public',
				status: 'published'
			},
			{ slug: `drf-${randomUUID()}`, categoryId: category!.id, tier: 'request', status: 'draft' }
		])
		.returning();

	requestTierId = inserted[0]!.id;
	ndaTierId = inserted[1]!.id;
	publicTierId = inserted[2]!.id;
	draftRequestTierId = inserted[3]!.id;

	await db
		.insert(documentTranslation)
		.values({ documentId: requestTierId, locale: 'en', title: 'Penetration test report' });
});

afterAll(async () => {
	await close();
});

const submission = {
	name: 'A Person',
	company: 'Acme',
	justification: null,
	locale: 'de',
	linkTtlMinutes: 30
};

describe('requestableDocuments', () => {
	it('offers published request-tier documents only', async () => {
		const ids = (await requestableDocuments(db, 'en')).map((row) => row.id);

		expect(ids).toContain(requestTierId);
		// NDA-tier is Phase 3. Offering it would produce a grant nothing can honour.
		expect(ids).not.toContain(ndaTierId);
		// A public document needs no request.
		expect(ids).not.toContain(publicTierId);
		// A draft is not published, so it is not on offer either.
		expect(ids).not.toContain(draftRequestTierId);
	});

	it('falls back to the slug when the locale has no translation', async () => {
		const rows = await requestableDocuments(db, 'de');
		const row = rows.find((r) => r.id === requestTierId);

		expect(row?.title).toBe(row?.slug);
	});

	it('uses the translated title when one exists', async () => {
		const rows = await requestableDocuments(db, 'en');
		const row = rows.find((r) => r.id === requestTierId);

		expect(row?.title).toBe('Penetration test report');
	});
});

describe('submitRequest', () => {
	it('creates an unverified request with no requester and the scope attached', async () => {
		const email = `person-${randomUUID()}@acme.example`;
		const { requestId } = await submitRequest(db, {
			...submission,
			email,
			documentIds: [requestTierId],
			tiers: []
		});

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('unverified');
		expect(row?.requesterId).toBeNull();
		expect(row?.submittedEmail).toBe(email.toLowerCase());

		const scope = await db
			.select()
			.from(accessRequestDocument)
			.where(eq(accessRequestDocument.requestId, requestId));
		expect(scope.map((s) => s.documentId)).toEqual([requestTierId]);
	});

	it('issues a magic link bound to the request', async () => {
		const { requestId, magicLinkToken } = await submitRequest(db, {
			...submission,
			email: `person-${randomUUID()}@acme.example`,
			documentIds: [requestTierId],
			tiers: []
		});

		expect(magicLinkToken.length).toBeGreaterThan(20);

		const links = await db.select().from(magicLink).where(eq(magicLink.requestId, requestId));
		expect(links).toHaveLength(1);
		expect(links[0]!.purpose).toBe('verify_request');
		// Hashed at rest: a database disclosure must not hand over a working link.
		expect(links[0]!.tokenHash).not.toBe(magicLinkToken);
	});

	it('refuses a document the requester may not ask for', async () => {
		// The picker filters NDA-tier out; the server must too, or the filter is
		// decoration rather than a control.
		await expect(
			submitRequest(db, {
				...submission,
				email: `person-${randomUUID()}@acme.example`,
				documentIds: [ndaTierId],
				tiers: []
			})
		).rejects.toThrow(/not requestable/i);
	});

	it('refuses an unpublished document', async () => {
		await expect(
			submitRequest(db, {
				...submission,
				email: `person-${randomUUID()}@acme.example`,
				documentIds: [draftRequestTierId],
				tiers: []
			})
		).rejects.toThrow(/not requestable/i);
	});

	it('leaves nothing behind when it refuses', async () => {
		// The whole submission is one transaction: a rejected scope must not leave
		// an orphaned request or a usable magic link.
		const before = await db.select().from(accessRequest);

		await expect(
			submitRequest(db, {
				...submission,
				email: `person-${randomUUID()}@acme.example`,
				documentIds: [ndaTierId],
				tiers: []
			})
		).rejects.toThrow();

		expect(await db.select().from(accessRequest)).toHaveLength(before.length);
	});

	it('accepts an all-request-tier submission with no explicit documents', async () => {
		const { requestId } = await submitRequest(db, {
			...submission,
			email: `person-${randomUUID()}@acme.example`,
			documentIds: [],
			tiers: ['request']
		});

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.allRequestTier).toBe(true);
	});

	it('stores a submitted tier blanket as a set', async () => {
		const { requestId } = await submitRequest(db, {
			...submission,
			email: `person-${randomUUID()}@acme.example`,
			documentIds: [],
			tiers: ['request']
		});

		expect(await requestTiers(db, requestId)).toEqual(['request']);
	});

	it('refuses a submitted nda tier in this phase', async () => {
		// The public form does not offer it; this is the server refusing a posted
		// one, which is where Phase 2 put the same guarantee.
		await expect(
			submitRequest(db, {
				...submission,
				email: `person-${randomUUID()}@acme.example`,
				documentIds: [],
				tiers: ['nda']
			})
		).rejects.toThrow(RequestRejected);
	});

	it('refuses a submission that names nothing at all', async () => {
		await expect(
			submitRequest(db, {
				...submission,
				email: `person-${randomUUID()}@acme.example`,
				documentIds: [],
				tiers: []
			})
		).rejects.toThrow(/empty scope/i);
	});

	it('issues a fresh request for an email that already has one', async () => {
		// Enumeration resistance: a repeat submission behaves exactly like a first
		// one, so nothing observable distinguishes a known email from a new one.
		const email = `person-${randomUUID()}@acme.example`;
		const payload = {
			...submission,
			email,
			documentIds: [requestTierId],
			tiers: []
		};

		const first = await submitRequest(db, payload);
		const second = await submitRequest(db, payload);

		expect(second.requestId).not.toBe(first.requestId);
		expect(second.magicLinkToken).not.toBe(first.magicLinkToken);
	});
});
