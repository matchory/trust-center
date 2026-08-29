import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { submitRequest } from '../../src/lib/server/access/requests';
import { verifyRequest } from '../../src/lib/server/access/verify';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRequest,
	accessRule,
	documentCategory,
	document as documentTable,
	outboundEmail
} from '../../src/lib/server/db/schema';

let db: Db;
let close: () => Promise<void>;
let docId: string;

const GRANT_TTL_DAYS = 30;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${randomUUID()}` })
		.returning();
	const [doc] = await db
		.insert(documentTable)
		.values({
			slug: `req-${randomUUID()}`,
			categoryId: category!.id,
			tier: 'request',
			status: 'published'
		})
		.returning();
	docId = doc!.id;
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Rules are the only shared state a case here mutates; the outbox is asserted
	// on per case, so it starts empty too.
	await db.delete(accessRule);
	await db.delete(outboundEmail);
});

async function submitFrom(domain: string) {
	return submitRequest(db, {
		email: `person-${randomUUID()}@${domain}`,
		name: 'A Person',
		company: 'Acme',
		justification: null,
		documentIds: [docId],
		allRequestTier: false,
		locale: 'de',
		linkTtlMinutes: 60
	});
}

function verify(token: string, staffNotification?: { to: string; baseUrl: string }) {
	return verifyRequest(db, {
		token,
		ip: null,
		ua: null,
		locale: 'de',
		grantTtlDays: GRANT_TTL_DAYS,
		staffNotification: staffNotification
			? { to: staffNotification.to, locale: 'de', baseUrl: staffNotification.baseUrl }
			: null
	});
}

describe('verifyRequest', () => {
	it('creates the requester, adopts the row, and clears the submitted columns', async () => {
		const { requestId, magicLinkToken } = await submitFrom(`d${Date.now()}.example`);

		const outcome = await verify(magicLinkToken);
		expect(outcome.ok).toBe(true);

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.requesterId).not.toBeNull();
		expect(row?.submittedEmail).toBeNull();
		expect(row?.submittedName).toBeNull();
		expect(row?.submittedCompany).toBeNull();
	});

	it('leaves an unmatched domain pending for a human', async () => {
		const { requestId, magicLinkToken } = await submitFrom(`unknown${Date.now()}.example`);

		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('pending');
		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('pending');
	});

	it('auto-approves a matching domain and creates a grant', async () => {
		const domain = `auto${Date.now()}.example`;
		await db.insert(accessRule).values({
			pattern: domain,
			action: 'auto_approve',
			maxTier: 'request',
			priority: 10
		});

		const { requestId, magicLinkToken } = await submitFrom(domain);
		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('approved');

		const grants = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
		expect(grants).toHaveLength(1);
		expect(grants[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('denies a matching deny rule and creates no grant', async () => {
		const domain = `deny${Date.now()}.example`;
		await db.insert(accessRule).values({ pattern: domain, action: 'deny', priority: 10 });

		const { requestId, magicLinkToken } = await submitFrom(domain);
		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('denied');
		expect(
			await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId))
		).toHaveLength(0);
	});

	it('refuses a replayed token', async () => {
		const { magicLinkToken } = await submitFrom(`replay${Date.now()}.example`);

		expect((await verify(magicLinkToken)).ok).toBe(true);
		expect((await verify(magicLinkToken)).ok).toBe(false);
	});

	it('notifies staff about a pending request, and not about an approved one', async () => {
		const notify = { to: 'trust@matchory.example', baseUrl: 'https://trust.example' };

		const pending = await submitFrom(`human${Date.now()}.example`);
		await verify(pending.magicLinkToken, notify);

		const queued = await db.select().from(outboundEmail);
		expect(queued).toHaveLength(1);
		expect(queued[0]?.template).toBe('staff_new_request');
		expect(queued[0]?.to).toBe(notify.to);
		expect(String((queued[0]?.payload as { url?: string })?.url)).toContain(pending.requestId);

		const domain = `quiet${Date.now()}.example`;
		await db.insert(accessRule).values({ pattern: domain, action: 'auto_approve', priority: 10 });
		const approved = await submitFrom(domain);
		await verify(approved.magicLinkToken, notify);

		expect(await db.select().from(outboundEmail)).toHaveLength(1);
	});
});
