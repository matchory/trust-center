import { expect, test, type Page } from '@playwright/test';

export async function signInAsAdmin(page: Page) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	await expect(page).toHaveURL(/\/admin$/);
}

const suffix = Date.now().toString(36);

test('an admin can publish a control and see it on the portal', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/controls/groups');
	await page.getByTestId('group-slug').fill(`grp-${suffix}`);
	await page.getByTestId('group-name-de').fill('Zugriffskontrolle');
	await page.getByTestId('group-create').click();
	await expect(
		page.getByTestId(`group-row-grp-${suffix}`).locator('input[name="name.de"]')
	).toHaveValue('Zugriffskontrolle');

	await page.goto('/de/admin/controls/new');
	await page.getByTestId('control-slug').fill(`ctl-${suffix}`);
	await page.getByTestId('control-group').selectOption({ label: 'Zugriffskontrolle' });
	await page.getByTestId('control-create').click();
	await expect(page).toHaveURL(/\/admin\/controls\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('Mehr-Faktor-Authentifizierung');
	await page.getByTestId('translation-save-de').click();

	await page.getByTestId('control-status').selectOption('implemented');
	await page.getByTestId('control-published').check();
	await page.getByTestId('control-save-meta').click();

	await page.goto('/de/controls');
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toBeVisible();
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toContainText('Umgesetzt');
});
