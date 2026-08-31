import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createGroup } from '../../src/lib/server/access/groups';
import { submitRequest } from '../../src/lib/server/access/requests';
import { grantGroups } from '../../src/lib/server/access/scope';
import { verifyRequest } from '../../src/lib/server/access/verify';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGrantDocument,
	documentCategory,
	document,
	outboundEmail
} from '../../src/lib/server/db/schema';
import { gotoAdmin, signInAsAdmin } from '../helpers/admin';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

let db: Db;
let closeDb: () => Promise<void>;
let docA: string;
let docB: string;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: 'triage-fixture' })
		.returning();

	const insert = async (slug: string) => {
		const [row] = await db
			.insert(document)
			.values({ slug, categoryId: category!.id, tier: 'request', status: 'published' })
			.returning({ id: document.id });
		return row!.id;
	};

	docA = await insert('triage-fixture-a');
	docB = await insert('triage-fixture-b');
});

test.afterAll(async () => {
	await db.delete(document).where(eq(document.slug, 'triage-fixture-a'));
	await db.delete(document).where(eq(document.slug, 'triage-fixture-b'));
	await db.delete(documentCategory).where(eq(documentCategory.slug, 'triage-fixture'));
	await closeDb();
});

/**
 * A verified request awaiting a human, seeded through the server modules. No
 * rule matches the generated domain, so rule evaluation leaves it pending —
 * which is the state the queue exists to resolve.
 */
async function pendingRequest(): Promise<{ requestId: string; email: string }> {
	const email = `triage-${randomUUID()}@nomatch-${Date.now()}.example`;

	const { requestId, magicLinkToken } = await submitRequest(db, {
		email,
		name: 'E2E Person',
		company: 'Acme',
		justification: 'We are evaluating you as a supplier.',
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
		grantTtlDays: 30
	});

	if (!outcome.ok || outcome.status !== 'pending') {
		throw new Error(`fixture request is not pending — got ${JSON.stringify(outcome)}`);
	}

	return { requestId, email };
}

test('an approver narrows a pending request and the requester is told', async ({ page }) => {
	const { requestId, email } = await pendingRequest();

	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/requests');
	await expect(page.getByTestId(`request-status-${requestId}`)).toHaveText('Offen');

	await gotoAdmin(page, `/de/admin/requests/${requestId}`);
	// The prospect asked for both; the approver grants one.
	await page.getByTestId('decision-document-triage-fixture-b').uncheck();
	await page.getByTestId('decision-approve').click();

	await expect(page.getByTestId('request-detail-status')).toHaveText('Genehmigt');

	const [grant] = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
	expect(grant).toBeTruthy();

	const scope = await db
		.select({ documentId: accessGrantDocument.documentId })
		.from(accessGrantDocument)
		.where(eq(accessGrantDocument.grantId, grant!.id));
	expect(scope.map((row) => row.documentId)).toEqual([docA]);

	const mail = (await db.select().from(outboundEmail).where(eq(outboundEmail.to, email))).filter(
		(row) => row.template === 'request_approved'
	);
	expect(mail).toHaveLength(1);
	// A sign-in link, not a bare portal URL: the requester's session from
	// verification is long gone by the time a human decides.
	expect(String((mail[0]?.payload as { url?: string })?.url)).toMatch(
		/\/de\/access\/verify\?token=/
	);
	// The requester's locale, recorded at verification — not the operator's.
	expect(mail[0]?.locale).toBe('de');
});

test('an approver grants a group and a term in days', async ({ page }) => {
	// The scope the approver chooses is not the one that was asked for: the
	// prospect named two documents, and the approver replaces them with a saved
	// bundle, which is the whole point of a group.
	const { requestId } = await pendingRequest();
	const slug = `e2e-pack-${randomUUID().slice(0, 8)}`;
	const groupId = await createGroup(db, { slug, position: 0 });

	await signInAsAdmin(page);
	await gotoAdmin(page, `/de/admin/requests/${requestId}`);

	await page.getByTestId('decision-document-triage-fixture-a').uncheck();
	await page.getByTestId('decision-document-triage-fixture-b').uncheck();
	await page.getByTestId(`decision-group-${slug}`).check();
	await page.getByTestId('decision-term-days').fill('14');
	await page.getByTestId('decision-approve').click();

	await expect(page.getByTestId('request-detail-status')).toHaveText('Genehmigt');

	const [grant] = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
	expect(await grantGroups(db, grant!.id)).toEqual([groupId]);
	expect(grant?.termDays).toBe(14);

	// The term is what the approver chose; the expiry is derived from it. Not
	// null: nothing in this phase yet mints an inert grant.
	const days = (grant!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
	expect(days).toBeGreaterThan(13);
	expect(days).toBeLessThanOrEqual(14);
});

test('a denial records a reason, mints no grant, and mails the requester', async ({ page }) => {
	const { requestId, email } = await pendingRequest();

	await signInAsAdmin(page);
	await gotoAdmin(page, `/de/admin/requests/${requestId}`);

	await page.fill('textarea[name="reason"]', 'Kein laufender Beschaffungsvorgang.');
	await page.getByTestId('decision-deny').click();

	await expect(page.getByTestId('request-detail-status')).toHaveText('Abgelehnt');
	expect(
		await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId))
	).toHaveLength(0);

	const mail = (await db.select().from(outboundEmail).where(eq(outboundEmail.to, email))).filter(
		(row) => row.template === 'request_denied'
	);
	expect(mail).toHaveLength(1);
});

test('a decided request offers no second decision', async ({ page }) => {
	// decideRequest refuses one, so the form would only produce a 409 — and a
	// second approval would mean a second grant.
	const { requestId } = await pendingRequest();

	await signInAsAdmin(page);
	await gotoAdmin(page, `/de/admin/requests/${requestId}`);
	await page.getByTestId('decision-approve').click();
	await expect(page.getByTestId('request-detail-status')).toHaveText('Genehmigt');

	await expect(page.getByTestId('decision-approve')).toHaveCount(0);
});

test('the queue never lists an unverified request', async ({ page }) => {
	// Nobody has proven they control that address, there is no decision to make,
	// and listing it would put unverified email in front of an operator.
	const email = `unverified-${randomUUID()}@nomatch-${Date.now()}.example`;
	const { requestId } = await submitRequest(db, {
		email,
		name: 'E2E Person',
		company: 'Acme',
		justification: null,
		documentIds: [docA],
		tiers: [],
		locale: 'de',
		linkTtlMinutes: 60
	});

	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/requests');

	await expect(page.getByTestId(`request-status-${requestId}`)).toHaveCount(0);
	expect(await page.content()).not.toContain(email);
});
