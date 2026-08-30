import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin } from '../helpers/admin';

test.describe('admin access groups', () => {
	test('creates, translates, and deletes a group', async ({ page }) => {
		await signInAsAdmin(page);

		// English throughout: the list shows a translation only for the page's
		// resolved locale, and this project pins the browser to de-DE, so an
		// unprefixed navigation would resolve 'de' and never see the 'en' name
		// this test writes.
		await gotoAdmin(page, '/en/admin/groups');
		await page.getByTestId('group-slug').fill('customer-pack');
		await page.getByTestId('group-create').click();

		const row = page.getByTestId('group-row-customer-pack');
		await expect(row).toBeVisible();
		// A group with no translation is shown by slug rather than blank.
		await expect(row).toContainText('customer-pack');

		await row.getByRole('link').click();
		await page.getByTestId('group-name-en').fill('Customer pack');
		await page.getByTestId('group-description-en').fill('Everything a customer may request');
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.request().method() === 'POST' && response.url().includes('saveTranslations')
			),
			page.getByTestId('group-save').click()
		]);
		await expect(page.getByTestId('group-name-en')).toHaveValue('Customer pack');

		await gotoAdmin(page, '/en/admin/groups');
		await expect(page.getByTestId('group-row-customer-pack')).toContainText('Customer pack');

		await page.getByTestId('group-row-customer-pack').getByRole('link').click();
		await page.getByTestId('group-delete').click();
		await expect(page.getByTestId('group-row-customer-pack')).toHaveCount(0);
	});

	test('rejects a slug that is not url-safe', async ({ page }) => {
		await signInAsAdmin(page);

		await gotoAdmin(page, '/admin/groups');
		await page.getByTestId('group-slug').fill('Customer Pack!');
		await page.getByTestId('group-create').click();

		await expect(page.getByTestId('error-slug')).toBeVisible();
		await expect(page.getByTestId('group-row-Customer Pack!')).toHaveCount(0);
	});
});
