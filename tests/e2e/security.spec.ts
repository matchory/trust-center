import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { documentCategory, document } from '../../src/lib/server/db/schema';
import {
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const categoryId = await createCategory(db, { slug: 'security-fixture', position: 99 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Sicherheits-Fixture' });
	await setCategoryTranslation(db, categoryId, 'en', { name: 'Security fixture' });

	for (const [slug, tier] of [
		['public-fixture', 'public'],
		['gated-fixture', 'request']
	] as const) {
		const id = await createDocument(db, { slug, categoryId, tier, position: 0 });
		await setDocumentTranslation(db, id, 'de', { title: `Fixture ${slug}`, summary: null });
		await setDocumentTranslation(db, id, 'en', { title: `Fixture ${slug}`, summary: null });
		await updateDocument(db, id, { status: 'published' });
	}
});

test.afterAll(async () => {
	await db.delete(document).where(eq(document.slug, 'public-fixture'));
	await db.delete(document).where(eq(document.slug, 'gated-fixture'));
	await db.delete(documentCategory).where(eq(documentCategory.slug, 'security-fixture'));
	await closeDb();
});

test('a gated document never appears in public HTML', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.getByTestId('document-public-fixture')).toBeVisible();
	await expect(page.getByTestId('document-gated-fixture')).toHaveCount(0);
	expect(await page.content()).not.toContain('gated-fixture');
});
