import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import {
	addDocumentFile,
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';
import { seedRule } from '../setup/fixtures';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRequest,
	accessRule,
	auditEvent,
	documentCategory,
	document,
	documentFile,
	magicLink,
	requester,
	outboundEmail,
	rateLimit
} from '../../src/lib/server/db/schema';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import { awaitHydration } from '../helpers/hydration';
import { blankPdf, drawnText } from '../helpers/pdf';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

const SLUG = 'journey-gated-fixture';
const CATEGORY_SLUG = 'journey-fixture';
// Auto-approved, so the journey reaches a download without a staff decision —
// triage has its own spec. Unique per run so this file's rule cannot decide
// another spec's submission.
const AUTO_DOMAIN = `journey-auto-${Date.now()}.example`;

let db: Db;
let closeDb: () => Promise<void>;
let documentId: string;
let ruleId: string;
let storedBytes: number;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const categoryId = await createCategory(db, { slug: CATEGORY_SLUG, position: 97 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Journey-Fixture' });

	documentId = await createDocument(db, {
		slug: SLUG,
		categoryId,
		tier: 'request',
		position: 0
	});
	await setDocumentTranslation(db, documentId, 'de', {
		title: 'Journey Bericht',
		summary: null
	});
	await updateDocument(db, documentId, { status: 'published' });

	// A real PDF: the watermarker refuses bytes it cannot parse, so a plausible
	// string would fail the download rather than exercise it.
	const storage = createLocalStorage(process.env.STORAGE_DIR ?? './data/storage');
	const stored = await storage.put(newStorageKey(), await blankPdf(2));
	storedBytes = stored.size;

	await addDocumentFile(db, {
		documentId,
		locale: 'de',
		storageKey: stored.key,
		sha256: stored.sha256,
		sizeBytes: stored.size,
		filename: 'journey.pdf',
		contentType: 'application/pdf',
		validFrom: null,
		validUntil: null,
		uploadedByStaffId: null
	});

	ruleId = await seedRule(db, { pattern: AUTO_DOMAIN, priority: 4, tiers: ['request'] });
});

test.afterAll(async () => {
	await db.delete(accessRule).where(eq(accessRule.id, ruleId));
	await db.delete(document).where(eq(document.slug, SLUG));
	await db.delete(documentCategory).where(eq(documentCategory.slug, CATEGORY_SLUG));
	await closeDb();
});

// The submission limiter allows five per hour per address. This spec submits
// through the real form, so it needs the same reset request.spec.ts uses.
test.beforeEach(async () => {
	await db.delete(rateLimit);
});

test('a prospect requests, verifies, downloads, and is cut off on revocation', async ({
	page,
	context
}) => {
	const email = `journey-${randomUUID()}@${AUTO_DOMAIN}`;

	// 1–2. The gated document is named on the public listing, with its badge and
	// its request affordance — and no file to download.
	await page.goto('/de/documents');
	await expect(page.getByTestId(`document-${SLUG}`)).toBeVisible();
	await expect(page.getByTestId(`request-access-${SLUG}`)).toBeVisible();
	await expect(page.getByTestId(`download-${SLUG}`)).toHaveCount(0);

	const publicHtml = await page.content();

	// 3. Submit the form for that one document, not the whole tier.
	await page.goto('/de/request');
	await awaitHydration(page);
	await page.fill('input[name="email"]', email);
	await page.fill('input[name="name"]', 'Journey Person');
	await page.fill('input[name="company"]', 'Acme');
	await page.check(`input[name="documentIds"][value="${documentId}"]`);
	await page.click('button[type="submit"]');
	await expect(page.getByTestId('request-submitted')).toBeVisible();

	// 4. The verification mail is queued, not sent inline — read the token out
	// of the queue rather than out of Mailpit, which would buy flakiness for
	// nothing.
	const [queued] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, email));
	expect(queued?.template).toBe('verify_request');
	const linkUrl = String((queued?.payload as { url?: string } | null)?.url ?? '');
	const token = new URL(linkUrl).searchParams.get('token');
	expect(token).toBeTruthy();

	const [request] = await db
		.select({ id: accessRequest.id })
		.from(accessRequest)
		.where(eq(accessRequest.submittedEmail, email));
	expect(request).toBeTruthy();

	// 5. Following the link renders a confirmation and consumes nothing. This is
	// the whole of decision 4: enterprise mail gateways prefetch links to scan
	// them, and a single-use link burned by a scanner strands the requester.
	await page.goto(`/de/access/verify?token=${encodeURIComponent(token!)}`);
	await expect(page.getByTestId('verify-confirm')).toBeVisible();

	const [beforeConfirm] = await db
		.select({ consumedAt: magicLink.consumedAt })
		.from(magicLink)
		.where(eq(magicLink.requestId, request!.id));
	expect(beforeConfirm?.consumedAt).toBeNull();

	// 6. The POST is what consumes it.
	await page.getByTestId('verify-confirm').click();
	await expect(page).toHaveURL(/\/de\/access$/);

	const cookies = await context.cookies();
	expect(cookies).toHaveLength(1);
	expect(cookies[0]?.name).toBe('__Secure-tc_requester_session');
	expect(cookies[0]?.path).toBe('/de/access');

	// 7. The rule auto-approved, so the document is there.
	await expect(page.getByTestId(`access-document-${SLUG}`)).toBeVisible();
	const href = await page.getByTestId(`access-download-${SLUG}`).getAttribute('href');
	if (!href) throw new Error('no download link on the gated portal');

	// 8. The download is watermarked, uncacheable, and correctly sized — a
	// content-length taken from the stored file would truncate the response at
	// the byte the unstamped file ended.
	const download = await page.request.get(href);
	expect(download.status()).toBe(200);
	expect(download.headers()['content-type']).toContain('application/pdf');
	expect(download.headers()['cache-control']).toMatch(/no-store/);

	const body = await download.body();
	expect(Number(download.headers()['content-length'])).toBe(body.byteLength);
	expect(body.byteLength).toBeGreaterThan(storedBytes);
	expect(drawnText(body)).toContain(email);

	// 9. Every download is audited, and the stamp is recorded as applied.
	const [file] = await db
		.select({ id: documentFile.id })
		.from(documentFile)
		.where(eq(documentFile.documentId, documentId));

	const downloads = await db
		.select({ meta: auditEvent.meta })
		.from(auditEvent)
		.where(
			and(
				eq(auditEvent.action, 'document.downloaded'),
				eq(auditEvent.actorType, 'requester'),
				eq(auditEvent.subjectId, file!.id)
			)
		);
	expect(downloads.length).toBeGreaterThan(0);
	expect(
		downloads.some((row) => (row.meta as { watermarked?: boolean })?.watermarked === true)
	).toBe(true);

	// 10. Revocation takes effect on the next attempt: no restart, no cache to
	// invalidate, nothing to expire.
	const [person] = await db
		.select({ id: requester.id })
		.from(requester)
		.where(eq(requester.email, email));

	await db
		.update(accessGrant)
		.set({ revokedAt: new Date() })
		.where(eq(accessGrant.requesterId, person!.id));

	const afterRevoke = await page.request.get(href);
	expect(afterRevoke.status()).toBe(404);

	// 11. And the public listing never named the file, before or after.
	expect(publicHtml).not.toContain(file!.id);
	await page.goto('/de/documents');
	expect(await page.content()).not.toContain(file!.id);
});
