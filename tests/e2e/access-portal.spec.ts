import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { submitRequest } from '../../src/lib/server/access/requests';
import {
	addDocumentFile,
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';
import { createDb, type Db } from '../../src/lib/server/db';
import { accessRule, documentCategory, document } from '../../src/lib/server/db/schema';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import { blankPdf, drawnText } from '../helpers/pdf';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

// Auto-approved so verification produces a grant without a human. Unique per
// run so this file's rule cannot decide another spec's submission.
const AUTO_DOMAIN = `portal-auto-${Date.now()}.example`;

let db: Db;
let closeDb: () => Promise<void>;
let documentId: string;
let ruleId: string;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const categoryId = await createCategory(db, { slug: 'access-portal-fixture', position: 98 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Zugriffs-Fixture' });

	documentId = await createDocument(db, {
		slug: 'portal-gated-fixture',
		categoryId,
		tier: 'request',
		position: 0
	});
	await setDocumentTranslation(db, documentId, 'de', {
		title: 'Vertraulicher Bericht',
		summary: null
	});
	await updateDocument(db, documentId, { status: 'published' });

	// A real PDF, not a plausible-looking string: the watermarker refuses bytes
	// it cannot parse, so a fake fixture would fail the download rather than
	// exercise it.
	const storage = createLocalStorage(process.env.STORAGE_DIR ?? './data/storage');
	const stored = await storage.put(newStorageKey(), await blankPdf(2));

	await addDocumentFile(db, {
		documentId,
		locale: 'de',
		storageKey: stored.key,
		sha256: stored.sha256,
		sizeBytes: stored.size,
		filename: 'bericht.pdf',
		contentType: 'application/pdf',
		validFrom: null,
		validUntil: null,
		uploadedByStaffId: null
	});

	const [rule] = await db
		.insert(accessRule)
		.values({ pattern: AUTO_DOMAIN, action: 'auto_approve', maxTier: 'request', priority: 5 })
		.returning({ id: accessRule.id });
	ruleId = rule!.id;
});

test.afterAll(async () => {
	await db.delete(accessRule).where(eq(accessRule.id, ruleId));
	await db.delete(document).where(eq(document.slug, 'portal-gated-fixture'));
	await db.delete(documentCategory).where(eq(documentCategory.slug, 'access-portal-fixture'));
	await closeDb();
});

/**
 * Submits through the server module rather than the form. The form has its own
 * coverage in request.spec.ts, and driving it here would spend the submission
 * limiter's shared per-address budget — which that spec asserts on.
 */
async function signIn(page: Page, domain: string): Promise<string> {
	const email = `portal-${randomUUID()}@${domain}`;

	const { magicLinkToken } = await submitRequest(db, {
		email,
		name: 'E2E Person',
		company: 'Acme',
		justification: null,
		documentIds: [documentId],
		tiers: [],
		locale: 'de',
		linkTtlMinutes: 60
	});

	await page.goto(`/de/access/verify?token=${encodeURIComponent(magicLinkToken)}`);
	await page.getByTestId('verify-confirm').click();

	return email;
}

test('an anonymous visitor is bounced out of the gated subtree', async ({ page }) => {
	await page.goto('/de/access');
	await expect(page).toHaveURL(/\/de\/request$/);
});

test('a verified requester lands on the portal and sees the granted document', async ({
	page,
	context
}) => {
	const email = await signIn(page, AUTO_DOMAIN);

	await expect(page).toHaveURL(/\/de\/access$/);
	await expect(page.getByTestId('access-identity')).toContainText(email);
	await expect(page.getByTestId('access-document-portal-gated-fixture')).toBeVisible();
	await expect(page.getByTestId('access-download-portal-gated-fixture')).toBeVisible();

	// Exactly one cookie, and only for the gated subtree.
	const cookies = await context.cookies();
	expect(cookies).toHaveLength(1);
	expect(cookies[0]?.name).toBe('__Secure-tc_requester_session');
	expect(cookies[0]?.path).toBe('/de/access');
	expect(cookies[0]?.httpOnly).toBe(true);
});

test('switching locale keeps the requester signed in', async ({ page, context }) => {
	await signIn(page, AUTO_DOMAIN);
	await expect(page).toHaveURL(/\/de\/access$/);

	await page.getByTestId('locale-switch-en').click();

	// The session cookie is scoped to a locale's own subtree, so switching
	// language is the one navigation that can silently end a session. It must
	// carry the requester across rather than dropping them on the request form.
	await expect(page).toHaveURL(/\/en\/access$/);
	await expect(page.getByTestId('access-identity')).toBeVisible();
	await expect(page.getByTestId('access-document-portal-gated-fixture')).toBeVisible();

	// Still exactly one cookie, now scoped to the locale actually being read.
	const cookies = await context.cookies();
	expect(cookies).toHaveLength(1);
	expect(cookies[0]?.name).toBe('__Secure-tc_requester_session');
	expect(cookies[0]?.path).toBe('/en/access');
});

test('the gated portal is never cached', async ({ page }) => {
	await signIn(page, AUTO_DOMAIN);

	const response = await page.goto('/de/access');
	expect(response?.headers()['cache-control']).toContain('no-store');
});

test('a requester whose request is still pending sees no documents', async ({ page }) => {
	// No rule matches this domain, so the decision is `review` — spec §9.3's
	// "everything else becomes pending". The session exists; the grant does not.
	await signIn(page, `portal-pending-${Date.now()}.example`);

	await expect(page).toHaveURL(/\/de\/access$/);
	await expect(page.getByTestId('access-empty')).toBeVisible();
	await expect(page.getByTestId('access-document-portal-gated-fixture')).toHaveCount(0);
});

test('signing out revokes the session immediately, at the server', async ({ page, context }) => {
	await signIn(page, AUTO_DOMAIN);

	// Taken before signing out, so the check below is that the *server* stopped
	// honouring it — not merely that the browser forgot it.
	const stolen = (await context.cookies()).find(
		(cookie) => cookie.name === '__Secure-tc_requester_session'
	);
	if (!stolen) throw new Error('no session cookie to steal — check signIn');

	await page.getByTestId('access-sign-out').click();
	await expect(page).toHaveURL(/\/de\/?$/);
	expect(await context.cookies()).toHaveLength(0);

	await context.addCookies([stolen]);
	await page.goto('/de/access');
	await expect(page).toHaveURL(/\/de\/request$/);
});

test('a spent verification link cannot be replayed', async ({ page }) => {
	const email = `portal-replay-${randomUUID()}@${AUTO_DOMAIN}`;
	const { magicLinkToken } = await submitRequest(db, {
		email,
		name: 'E2E Person',
		company: 'Acme',
		justification: null,
		documentIds: [documentId],
		tiers: [],
		locale: 'de',
		linkTtlMinutes: 60
	});

	const url = `/de/access/verify?token=${encodeURIComponent(magicLinkToken)}`;

	await page.goto(url);
	await page.getByTestId('verify-confirm').click();
	await expect(page).toHaveURL(/\/de\/access$/);

	await page.goto(url);
	await page.getByTestId('verify-confirm').click();
	await expect(page.getByTestId('verify-failed')).toBeVisible();
});

test('a grant holder downloads a watermarked copy that names them', async ({ page }) => {
	const email = await signIn(page, AUTO_DOMAIN);

	const href = await page.getByTestId('access-download-portal-gated-fixture').getAttribute('href');
	if (!href) throw new Error('no download link on the gated portal');

	const response = await page.request.get(href);
	expect(response.status()).toBe(200);
	expect(response.headers()['content-disposition']).toMatch(/attachment/);
	// Every download is audited, so no cache may satisfy one on our behalf.
	expect(response.headers()['cache-control']).toMatch(/no-store/);

	const body = await response.body();

	// The stored size would truncate the response at the byte the unstamped
	// file ended, and a browser would report a corrupt download.
	expect(Number(response.headers()['content-length'])).toBe(body.byteLength);

	const drawn = drawnText(body);
	expect(drawn).toContain(email);
	expect(drawn).toContain('Acme');
});
