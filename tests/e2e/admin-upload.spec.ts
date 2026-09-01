import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { documentCategory, documentFile } from '../../src/lib/server/db/schema';
import { draftVersion, gotoAdmin, signInAsAdmin, submitAndWait } from '../helpers/admin';
import { blankPdf } from '../helpers/pdf';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

// Matches playwright.config.ts's webServer env, which lowers both caps so the
// refusals below are reachable without a 25 MB, thousand-page fixture. What is
// under test is how an over-cap upload is handled, not the numbers.
const MAX_PAGES = 5;
const MAX_BYTES = 1024 * 1024;

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(() => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await closeDb();
});

/** A published document with no file yet, ready to receive one. */
async function emptyDocument(page: import('@playwright/test').Page): Promise<string> {
	const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;

	await gotoAdmin(page, '/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(`upload-cat-${stamp}`);
	await page.getByTestId('category-name-de').fill(`Kategorie ${stamp}`);
	await page.getByTestId('category-name-en').fill(`Category ${stamp}`);
	await submitAndWait(page, 'category-create', '?/create');

	await gotoAdmin(page, '/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(`upload-doc-${stamp}`);
	await page.getByTestId('document-category').selectOption({ label: `Kategorie ${stamp}` });
	await page.getByTestId('document-tier').selectOption('request');
	await submitAndWait(page, 'document-create', '/admin/documents/new');
	await expect(page).toHaveURL(/\/admin\/documents\/[0-9a-f-]{36}$/);

	return page.url().split('/').pop()!;
}

async function upload(
	page: import('@playwright/test').Page,
	name: string,
	buffer: Buffer
): Promise<void> {
	await page.getByTestId('file-input-de').setInputFiles({
		name,
		mimeType: 'application/pdf',
		buffer
	});
	await submitAndWait(page, 'file-upload-de', '?/uploadFile');
}

test('an operator uploads a PDF and it becomes the current file', async ({ page }) => {
	// The caps below are unit-tested; the route applying them had never been
	// driven by a browser, and 3c adds a second upload route that would inherit
	// that gap.
	await signInAsAdmin(page);
	const documentId = await emptyDocument(page);

	await upload(page, 'report.pdf', Buffer.from(await blankPdf(2)));

	const files = await db.select().from(documentFile).where(eq(documentFile.documentId, documentId));

	expect(files).toHaveLength(1);
	expect(files[0]!.filename).toBe('report.pdf');
	expect(files[0]!.isCurrent).toBe(true);
	expect(files[0]!.version).toBe(1);

	await gotoAdmin(page, `/de/admin/documents/${documentId}`);
	await expect(page.getByText('report.pdf')).toBeVisible();
});

test('an over-cap page count is refused with the reason, not a 500', async ({ page }) => {
	await signInAsAdmin(page);
	const documentId = await emptyDocument(page);

	await upload(page, 'too-many-pages.pdf', Buffer.from(await blankPdf(MAX_PAGES + 1)));

	// The form says why. A 500 here would tell an operator nothing and look like
	// the application is broken rather than the file being wrong.
	await expect(page.getByText(/too many pages/i)).toBeVisible();
	expect(
		await db.select().from(documentFile).where(eq(documentFile.documentId, documentId))
	).toHaveLength(0);
});

test('an over-size file is refused the same way', async ({ page }) => {
	await signInAsAdmin(page);
	const documentId = await emptyDocument(page);

	// A real PDF, padded past the byte cap while staying under the page cap, so
	// it is the size check that answers and not the page one.
	const padded = Buffer.concat([
		Buffer.from(await blankPdf(1)),
		Buffer.from(`\n% ${'x'.repeat(MAX_BYTES)}\n`)
	]);

	await upload(page, 'too-large.pdf', padded);

	await expect(page.getByText(/too large/i)).toBeVisible();
	expect(
		await db.select().from(documentFile).where(eq(documentFile.documentId, documentId))
	).toHaveLength(0);
});

test('a slug somebody already used is refused rather than 500ing', async ({ page }) => {
	// Postgres reports it as 23505, and no route handled it before this phase.
	await signInAsAdmin(page);
	const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;

	await gotoAdmin(page, '/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(`dupe-cat-${stamp}`);
	await page.getByTestId('category-name-de').fill(`Kategorie ${stamp}`);
	await page.getByTestId('category-name-en').fill(`Category ${stamp}`);
	await submitAndWait(page, 'category-create', '?/create');

	await gotoAdmin(page, '/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(`dupe-cat-${stamp}`);
	await page.getByTestId('category-name-de').fill(`Kategorie ${stamp} zwei`);
	await page.getByTestId('category-name-en').fill(`Category ${stamp} two`);
	await submitAndWait(page, 'category-create', '?/create');

	await expect(page.getByTestId('error-slug')).toBeVisible();
	expect(
		await db
			.select()
			.from(documentCategory)
			.where(eq(documentCategory.slug, `dupe-cat-${stamp}`))
	).toHaveLength(1);
});

test('the import route refuses a pdf over the page cap', async ({ page }) => {
	// §14 folded the upload cases into 3b because 3c adds a second route that
	// reads an operator-supplied PDF; without these two it would inherit the
	// gap the documents route no longer has.
	await gotoAdmin(page, await draftVersion(page));

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'huge.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(await blankPdf(MAX_PAGES + 1))
	});

	await submitAndWait(page, 'import-submit-de', '?/import');
	await expect(page.getByTestId('import-error')).toBeVisible();
});

test('the import route refuses a scan', async ({ page }) => {
	await gotoAdmin(page, await draftVersion(page));

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'scan.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(await blankPdf())
	});

	await submitAndWait(page, 'import-submit-de', '?/import');
	await expect(page.getByTestId('import-error')).toBeVisible();
});
