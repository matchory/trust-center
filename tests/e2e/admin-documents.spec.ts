import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin } from '../helpers/admin';

// Unique per run so repeated local runs against the shared dev database do not
// collide on the slug unique constraint.
const suffix = Date.now().toString(36);

test('an admin can create a category, a document, and publish it', async ({ page }) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(`cat-${suffix}`);
	await page.getByTestId('category-name-de').fill('Zertifikate');
	await page.getByTestId('category-name-en').fill('Certificates');
	await page.getByTestId('category-create').click();
	await expect(page.getByTestId(`category-row-cat-${suffix}`)).toContainText('Zertifikate');

	await gotoAdmin(page, '/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(`doc-${suffix}`);
	await page.getByTestId('document-category').selectOption({ label: 'Zertifikate' });
	await page.getByTestId('document-create').click();

	await expect(page).toHaveURL(/\/admin\/documents\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('ISO 27001 Zertifikat');
	await page.getByTestId('translation-save-de').click();
	await expect(page.getByTestId('translation-title-de')).toHaveValue('ISO 27001 Zertifikat');

	await page.getByTestId('document-publish').click();
	await expect(page.getByTestId('document-status')).toHaveText('published');

	// Published, public tier, and translated — so it is now on the portal.
	await page.goto('/de/documents');
	await expect(page.getByTestId(`document-doc-${suffix}`)).toBeVisible();
});

test('a document with no translation in any served locale stays off the portal', async ({
	page
}) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(`untitled-${suffix}`);
	await page.getByTestId('document-category').selectOption({ index: 0 });
	await page.getByTestId('document-create').click();
	await page.getByTestId('document-publish').click();

	await page.goto('/de/documents');
	await expect(page.getByTestId(`document-untitled-${suffix}`)).toHaveCount(0);
});

test('rejects a slug that is not URL-safe', async ({ page }) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/documents/new');
	await page.getByTestId('document-slug').fill('Not A Slug');
	await page.getByTestId('document-category').selectOption({ index: 0 });
	await page.getByTestId('document-create').click();

	await expect(page.getByTestId('error-slug')).toBeVisible();
});
