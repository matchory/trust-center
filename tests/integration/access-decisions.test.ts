import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	decideRequest,
	DecisionRejected,
	submitRequest
} from '../../src/lib/server/access/requests';
import { createGroup } from '../../src/lib/server/access/groups';
import { grantGroups, grantTiers } from '../../src/lib/server/access/scope';
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
const LOCALES = ['de', 'en'];

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
		tiers: [],
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
			tiers: [],
			groupIds: [],
			termDays: DEFAULT_TTL_DAYS,
			reason: null,
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
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
			tiers: [],
			groupIds: [],
			termDays: DEFAULT_TTL_DAYS,
			reason: null,
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
		});

		const [grant] = await grantsFor(requestId);
		const days = (grant!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

		expect(days).toBeGreaterThan(DEFAULT_TTL_DAYS - 1);
		expect(days).toBeLessThanOrEqual(DEFAULT_TTL_DAYS);
	});

	it('honours a term shorter than the default', async () => {
		// The approver names a term in days rather than an absolute date; the
		// expiry is derived from it, and the term itself is recorded because the
		// approver chose it.
		const requestId = await pendingRequest();

		await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [],
			tiers: ['request'],
			groupIds: [],
			termDays: 7,
			reason: null,
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
		});

		const [grant] = await grantsFor(requestId);
		const days = (grant!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

		expect(days).toBeGreaterThan(6);
		expect(days).toBeLessThanOrEqual(7);
		expect(grant?.termDays).toBe(7);
		expect(await grantTiers(db, grant!.id)).toEqual(['request']);
	});

	it('denies with a reason and creates no grant', async () => {
		const requestId = await pendingRequest();

		const { status } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'deny',
			documentIds: [],
			tiers: [],
			groupIds: [],
			termDays: DEFAULT_TTL_DAYS,
			reason: 'Not a customer',
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
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
			tiers: [],
			groupIds: [],
			termDays: DEFAULT_TTL_DAYS,
			reason: 'Which entity are you contracting through?',
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
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
				tiers: [],
				groupIds: [],
				termDays: DEFAULT_TTL_DAYS,
				reason: null,
				requirements: [],
				acceptanceDueDays: 14,
				locales: LOCALES
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
				tiers: [],
				groupIds: [],
				termDays: DEFAULT_TTL_DAYS,
				reason: null,
				requirements: [],
				acceptanceDueDays: 14,
				locales: LOCALES
			})
		).rejects.toBeInstanceOf(DecisionRejected);

		expect(await grantsFor(requestId)).toHaveLength(0);
	});

	it('grants the staff-chosen scope, not the requested one', async () => {
		// The prospect asked for two documents; the approver replaces that with a
		// group, which is the saved scope this phase exists to make grantable.
		const requestId = await pendingRequest();
		const groupId = await createGroup(db, { slug: `customer-${randomUUID()}`, position: 0 });

		const { grantId } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [],
			tiers: [],
			groupIds: [groupId],
			termDays: 30,
			reason: null,
			requirements: [],
			acceptanceDueDays: 14,
			locales: LOCALES
		});

		expect(await grantTiers(db, grantId!)).toEqual([]);
		expect(await grantGroups(db, grantId!)).toEqual([groupId]);
	});

	it('refuses an approval that grants nothing', async () => {
		const requestId = await pendingRequest();

		await expect(
			decideRequest(db, {
				requestId,
				staffUserId: staffId,
				decision: 'approve',
				documentIds: [],
				tiers: [],
				groupIds: [],
				termDays: DEFAULT_TTL_DAYS,
				reason: null,
				requirements: [],
				acceptanceDueDays: 14,
				locales: LOCALES
			})
		).rejects.toBeInstanceOf(DecisionRejected);
	});
});
