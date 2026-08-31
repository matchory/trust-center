import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantedDocuments } from '../../src/lib/server/access/grants';
import { createGroup, setDocumentGroups } from '../../src/lib/server/access/groups';
import { submitRequest } from '../../src/lib/server/access/requests';
import { grantTiers } from '../../src/lib/server/access/scope';
import { seedAgreement, seedRule } from '../setup/fixtures';
import { issueMagicLink } from '../../src/lib/server/identity/magic-link';
import { consumeSignInLink, verifyRequest } from '../../src/lib/server/access/verify';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRequest,
	accessGroup,
	accessRule,
	auditEvent,
	documentCategory,
	document as documentTable,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	outboundEmail,
	setting
} from '../../src/lib/server/db/schema';

let db: Db;
let close: () => Promise<void>;
let docId: string;

const GRANT_TTL_DAYS = 30;
const LOCALES = ['de', 'en'];

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
	// The last case leaves a group pointing at a template; `access_group
	// .nda_template_id` is ON DELETE RESTRICT, so another file's cleanup would
	// fail on it. Children before parents, as everywhere else. A surviving
	// grant is a child of the group too (`access_grant_group.group_id`, also
	// RESTRICT), so it must go first — see nda-delivery.test.ts's `reset`.
	await db.delete(accessGrant);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await close();
});

beforeEach(async () => {
	// Rules are the only shared state a case here mutates; the outbox is asserted
	// on per case, so it starts empty too.
	await db.delete(accessRule);
	await db.delete(outboundEmail);
	// Children before parents: `access_group.nda_template_id` is ON DELETE
	// RESTRICT, and a group left behind would gate `docId` for the next case.
	// A grant referencing the group (`access_grant_group.group_id`, also
	// RESTRICT) must go first, or the group delete throws 23001 intermittently
	// depending on whether a prior case in this file minted a grant.
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await db.delete(setting);
});

async function submitFrom(
	domain: string,
	scope: { tiers?: readonly string[]; documentIds?: readonly string[] } = {}
) {
	return submitRequest(db, {
		email: `person-${randomUUID()}@${domain}`,
		name: 'A Person',
		company: 'Acme',
		justification: null,
		documentIds: [...(scope.documentIds ?? [docId])],
		tiers: [...(scope.tiers ?? [])],
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
		const ruleId = await seedRule(db, { pattern: domain, priority: 10, tiers: ['request'] });

		const { requestId, magicLinkToken } = await submitFrom(domain);
		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('approved');

		const grants = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
		expect(grants).toHaveLength(1);
		expect(grants[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now());

		// Which rule decided is the question asked afterwards, and the audit log
		// is the only place it can be answered — the rule itself can be edited or
		// deleted, and `access_rule.deleted` is elsewhere in the same table.
		const [event] = await db
			.select({ meta: auditEvent.meta })
			.from(auditEvent)
			.where(and(eq(auditEvent.subjectType, 'access_request'), eq(auditEvent.subjectId, requestId)))
			.orderBy(desc(auditEvent.seq))
			.limit(1);

		expect(event?.meta).toMatchObject({ ruleId, grantId: grants[0]!.id });
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

describe('consumeSignInLink', () => {
	it('mints an identity for a known requester and refuses a replay', async () => {
		// Issued when staff decide a request: the requester's original session is
		// long gone by then.
		const { requestId, magicLinkToken } = await submitFrom(`signin${Date.now()}.example`);
		const verified = await verify(magicLinkToken);
		if (!verified.ok) throw new Error('fixture request did not verify');

		const { token } = await issueMagicLink(db, {
			purpose: 'sign_in',
			requesterId: verified.requesterId,
			ttlMinutes: 60
		});

		expect((await consumeSignInLink(db, { token, ip: null, ua: null }))?.requesterId).toBe(
			verified.requesterId
		);
		expect(await consumeSignInLink(db, { token, ip: null, ua: null })).toBeNull();
		expect(requestId).toBeTruthy();
	});

	it('does not consume a verification link presented as a sign-in link', async () => {
		// Purpose is part of the consuming UPDATE's predicate, so the wrong-purpose
		// attempt must leave the token usable.
		const { magicLinkToken } = await submitFrom(`purpose${Date.now()}.example`);

		expect(await consumeSignInLink(db, { token: magicLinkToken, ip: null, ua: null })).toBeNull();
		expect((await verify(magicLinkToken)).ok).toBe(true);
	});
});

describe('what an auto-approval may hand out', () => {
	it('grants only the tiers the rule permits and the request asked for', async () => {
		// decision.tiers was computed and never read: the grant took the request's
		// set alone, so a rule permitting nothing still handed out a blanket.
		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: [] });
		const { magicLinkToken } = await submitFrom('acme.example', {
			tiers: ['request'],
			documentIds: []
		});

		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.grantId).toBeTruthy();
		expect(await grantTiers(db, (outcome as { grantId: string }).grantId)).toEqual([]);
	});

	it('grants the intersection when both name a tier', async () => {
		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: ['request'] });
		const { magicLinkToken } = await submitFrom('acme.example', {
			tiers: ['request'],
			documentIds: []
		});

		const outcome = await verify(magicLinkToken);

		expect(await grantTiers(db, (outcome as { grantId: string }).grantId)).toEqual(['request']);
	});

	it('still grants explicitly named documents when the rule permits no blanket', async () => {
		// A rule with an empty set auto-approves explicit documents only. That is the
		// useful shape: "auto-approve this domain, but never the blanket".
		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: [] });
		const { magicLinkToken } = await submitFrom('acme.example', {
			tiers: [],
			documentIds: [docId]
		});

		const outcome = await verify(magicLinkToken);

		expect(
			await grantedDocuments(db, (outcome as { requesterId: string }).requesterId, {
				locales: LOCALES
			})
		).toHaveLength(1);
	});

	it('refuses to auto-approve a blanket whose proposal carries an agreement', async () => {
		// §10.1: a stranger from an allow-listed domain would otherwise verify by
		// magic link, be auto-approved with no human involved, click through, and
		// hold every NDA-tier document — including ones published next month — for
		// the full term. Every step is something an operator configured, and nobody
		// looked.
		const group = await createGroup(db, {
			slug: `gated-${randomUUID().slice(0, 8)}`,
			position: 0,
			ndaTemplateId: (
				await seedAgreement(db, { slug: `nda-${randomUUID().slice(0, 8)}`, locales: LOCALES })
			).templateId
		});
		await setDocumentGroups(db, docId, [group]);

		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: ['request'] });
		const { magicLinkToken } = await submitFrom('acme.example', {
			tiers: ['request'],
			documentIds: []
		});

		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('pending');
		expect(outcome.ok && outcome.grantId).toBeNull();
	});

	it('still auto-approves a blanket that carries no agreement', async () => {
		await seedRule(db, { pattern: 'acme.example', action: 'auto_approve', tiers: ['request'] });
		const { magicLinkToken } = await submitFrom('acme.example', {
			tiers: ['request'],
			documentIds: []
		});

		const outcome = await verify(magicLinkToken);

		expect(outcome.ok && outcome.status).toBe('approved');
	});
});
