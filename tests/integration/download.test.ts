import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGrant, mayDownload, revokeGrant } from '../../src/lib/server/access/grants';
import { upsertRequester } from '../../src/lib/server/identity/requester';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	documentCategory,
	document as documentTable,
	staffUser
} from '../../src/lib/server/db/schema';

let db: Db;
let close: () => Promise<void>;
let documentId: string;
let requesterId: string;
let otherRequesterId: string;
let staffId: string;

const IN_A_MONTH = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `dl-${randomUUID()}` })
		.returning();
	const [doc] = await db
		.insert(documentTable)
		.values({
			slug: `dl-${randomUUID()}`,
			categoryId: category!.id,
			tier: 'request',
			status: 'published'
		})
		.returning();
	documentId = doc!.id;

	requesterId = (
		await upsertRequester(db, {
			email: `holder-${randomUUID()}@acme.example`,
			name: 'A Holder',
			company: 'Acme',
			locale: 'de'
		})
	).id;

	otherRequesterId = (
		await upsertRequester(db, {
			email: `other-${randomUUID()}@acme.example`,
			name: 'Another Person',
			company: 'Acme',
			locale: 'de'
		})
	).id;

	const [staff] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `staff-${randomUUID()}@matchory.example`,
			name: 'Staff',
			role: 'admin'
		})
		.returning({ id: staffUser.id });
	staffId = staff!.id;
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	await db.delete(accessGrant);
	await db.update(documentTable).set({ tier: 'request', status: 'published' });
});

/**
 * The authorization matrix, asserted at the module boundary rather than through
 * the route: the endpoint needs a full SvelteKit event, and `mayDownload` is
 * the decision the endpoint makes. The route's own behaviour — 404 for a
 * gated file with no session, watermarking, the audit event — is covered in
 * tests/e2e/security.spec.ts and access-portal.spec.ts.
 */
describe('mayDownload', () => {
	it('admits a requester with a live grant naming the document', async () => {
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(true);
	});

	it('admits a requester holding an all-request-tier grant that names nothing', async () => {
		// Including documents published after the grant was made.
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: ['request'],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(true);
	});

	it('refuses once the grant is revoked, with no restart and no cache to clear', async () => {
		const { grantId } = await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(true);

		await revokeGrant(db, grantId, staffId);

		expect(await mayDownload(db, requesterId, documentId)).toBe(false);
	});

	it('refuses once the grant has expired', async () => {
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: new Date(Date.now() - 1000)
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(false);
	});

	it('refuses a different requester holding no grant of their own', async () => {
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		expect(await mayDownload(db, otherRequesterId, documentId)).toBe(false);
	});

	it('refuses once the document is moved to the NDA tier', async () => {
		// The tier is filtered at read time, not at grant time, so a document
		// promoted to `nda` stops being downloadable immediately — without
		// anyone remembering to revisit the grants that already exist.
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: ['request'],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(true);

		await db.update(documentTable).set({ tier: 'nda' }).where(eq(documentTable.id, documentId));

		expect(await mayDownload(db, requesterId, documentId)).toBe(false);
	});

	it('refuses once the document is unpublished', async () => {
		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: IN_A_MONTH()
		});

		await db.update(documentTable).set({ status: 'draft' }).where(eq(documentTable.id, documentId));

		expect(await mayDownload(db, requesterId, documentId)).toBe(false);
	});
});
