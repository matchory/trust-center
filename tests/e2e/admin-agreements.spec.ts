import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin, submitAndWait } from '../helpers/admin';

test('an operator creates an agreement and names it in both locales', async ({ page }) => {
	await signInAsAdmin(page);

	const slug = `mutual-${Date.now()}`;
	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(slug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');

	await expect(page).toHaveURL(/\/admin\/agreements\/[0-9a-f-]{36}$/);

	await page.getByTestId('agreement-name-de').fill('Gegenseitige Geheimhaltung');
	await page.getByTestId('agreement-name-en').fill('Mutual NDA');
	await submitAndWait(page, 'agreement-save-translations', '?/saveTranslations');

	await gotoAdmin(page, '/admin/agreements');
	await expect(page.getByText('Gegenseitige Geheimhaltung')).toBeVisible();
});

test('a new agreement has no effective version', async ({ page }) => {
	await signInAsAdmin(page);

	const slug = `draft-${Date.now()}`;
	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(slug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');

	// The blocked reason §5.2 requires: an agreement nobody can be asked to sign
	// must say so where an operator looks, not at the click-through.
	await expect(page.getByTestId('agreement-no-effective-version')).toBeVisible();
});
