import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	decideRequest,
	DecisionRejected,
	submitRequest
} from '../../src/lib/server/access/requests';
import { verifyRequest } from '../../src/lib/server/access/verify';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGrantDocument,
	accessRequest,
	documentCategory,
	document as documentTable,
	staffUser
} from '../../src/lib/server/db/schema';

let db: Db;
let close: () => Promise<void>;
let docA: string;
let docB: string;
let ndaDoc: string;
let staffId: string;

const DEFAULT_TTL_DAYS = 30;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `dec-${randomUUID()}` })
		.returning();

	const insert = async (tier: 'request' | 'nda') => {
		const [row] = await db
			.insert(documentTable)
			.values({
				slug: `dec-${randomUUID()}`,
				categoryId: category!.id,
				tier,
				status: 'published'
			})
			.returning({ id: documentTable.id });
		return row!.id;
	};

	docA = await insert('request');
	docB = await insert('request');
	ndaDoc = await insert('nda');

	const [staff] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `approver-${randomUUID()}@matchory.example`,
			name: 'An Approver',
			role: 'approver'
		})
		.returning({ id: staffUser.id });
	staffId = staff!.id;
});

afterAll(async () => {
	await close();
});

/** A verified, undecided request scoped to both request-tier documents. */
async function pendingRequest(): Promise<string> {
	const { requestId, magicLinkToken } = await submitRequest(db, {
		email: `person-${randomUUID()}@nomatch-${Date.now()}.example`,
		name: 'A Person',
		company: 'Acme',
		justification: null,
		documentIds: [docA, docB],
		allRequestTier: false,
		locale: 'de',
		linkTtlMinutes: 60
	});

	const outcome = await verifyRequest(db, {
		token: magicLinkToken,
		ip: null,
		ua: null,
		locale: 'de',
		grantTtlDays: DEFAULT_TTL_DAYS
	});

	// No rule matches the generated domain, so this lands in the queue.
	if (!outcome.ok || outcome.status !== 'pending') {
		throw new Error(`fixture request is not pending — got ${JSON.stringify(outcome)}`);
	}

	return requestId;
}

function grantsFor(requestId: string) {
	return db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
}

describe('decideRequest', () => {
	it('approves with the staff-chosen scope, not the requested one', async () => {
		// The prospect asked for both documents; the approver narrows it to one.
		// Granting what was asked for would make the control decorative.
		const requestId = await pendingRequest();

		const { status, grantId } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [docA],
			allRequestTier: false,
			expiresAt: null,
			defaultTtlDays: DEFAULT_TTL_DAYS,
			reason: null
		});

		expect(status).toBe('approved');

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('approved');
		expect(row?.decidedByStaffId).toBe(staffId);
		expect(row?.decidedAt).not.toBeNull();

		const grants = await grantsFor(requestId);
		expect(grants).toHaveLength(1);

		const scope = await db
			.select({ documentId: accessGrantDocument.documentId })
			.from(accessGrantDocument)
			.where(eq(accessGrantDocument.grantId, grantId!));

		expect(scope.map((entry) => entry.documentId)).toEqual([docA]);
	});

	it('falls back to the default term when no expiry is named', async () => {
		const requestId = await pendingRequest();

		await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [docA],
			allRequestTier: false,
			expiresAt: null,
			defaultTtlDays: DEFAULT_TTL_DAYS,
			reason: null
		});

		const [grant] = await grantsFor(requestId);
		const days = (grant!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

		expect(days).toBeGreaterThan(DEFAULT_TTL_DAYS - 1);
		expect(days).toBeLessThanOrEqual(DEFAULT_TTL_DAYS);
	});

	it('honours an explicit expiry', async () => {
		const requestId = await pendingRequest();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

		await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [],
			allRequestTier: true,
			expiresAt,
			defaultTtlDays: DEFAULT_TTL_DAYS,
			reason: null
		});

		const [grant] = await grantsFor(requestId);
		expect(grant?.expiresAt.getTime()).toBe(expiresAt.getTime());
		expect(grant?.allRequestTier).toBe(true);
	});

	it('denies with a reason and creates no grant', async () => {
		const requestId = await pendingRequest();

		const { status } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'deny',
			documentIds: [],
			allRequestTier: false,
			expiresAt: null,
			defaultTtlDays: DEFAULT_TTL_DAYS,
			reason: 'Not a customer'
		});

		expect(status).toBe('denied');

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('denied');
		expect(row?.reason).toBe('Not a customer');
		expect(await grantsFor(requestId)).toHaveLength(0);
	});

	it('leaves an info request undecided and creates no grant', async () => {
		const requestId = await pendingRequest();

		const { status } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'request_info',
			documentIds: [],
			allRequestTier: false,
			expiresAt: null,
			defaultTtlDays: DEFAULT_TTL_DAYS,
			reason: 'Which entity are you contracting through?'
		});

		expect(status).toBe('info_requested');

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('info_requested');
		expect(row?.decidedAt).toBeNull();
		expect(await grantsFor(requestId)).toHaveLength(0);
	});

	it('refuses to decide an already-decided request', async () => {
		// Idempotence is not enough: a second approval would mint a second grant.
		const requestId = await pendingRequest();
		const approve = () =>
			decideRequest(db, {
				requestId,
				staffUserId: staffId,
				decision: 'approve',
				documentIds: [docA],
				allRequestTier: false,
				expiresAt: null,
				defaultTtlDays: DEFAULT_TTL_DAYS,
				reason: null
			});

		await approve();
		await expect(approve()).rejects.toBeInstanceOf(DecisionRejected);

		expect(await grantsFor(requestId)).toHaveLength(1);
	});

	it('refuses an approval naming an NDA-tier document', async () => {
		const requestId = await pendingRequest();

		await expect(
			decideRequest(db, {
				requestId,
				staffUserId: staffId,
				decision: 'approve',
				documentIds: [docA, ndaDoc],
				allRequestTier: false,
				expiresAt: null,
				defaultTtlDays: DEFAULT_TTL_DAYS,
				reason: null
			})
		).rejects.toBeInstanceOf(DecisionRejected);

		expect(await grantsFor(requestId)).toHaveLength(0);
	});

	it('refuses an approval that grants nothing', async () => {
		const requestId = await pendingRequest();

		await expect(
			decideRequest(db, {
				requestId,
				staffUserId: staffId,
				decision: 'approve',
				documentIds: [],
				allRequestTier: false,
				expiresAt: null,
				defaultTtlDays: DEFAULT_TTL_DAYS,
				reason: null
			})
		).rejects.toBeInstanceOf(DecisionRejected);
	});
});
