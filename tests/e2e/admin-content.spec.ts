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

/**
 * `use:enhance` submits over fetch, so a `page.goto` fired straight after a
 * click can outrun the action. Wait for the POST to come back before asserting
 * on anything the action wrote.
 */
async function submitAndWait(page: Page, testId: string, action: string) {
	await Promise.all([
		page.waitForResponse(
			(response) => response.request().method() === 'POST' && response.url().includes(action)
		),
		page.getByTestId(testId).click()
	]);
}

const suffix = Date.now().toString(36);

test('an admin can publish a control and see it on the portal', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/controls/groups');
	await page.getByTestId('group-slug').fill(`grp-${suffix}`);
	await page.getByTestId('group-name-de').fill('Zugriffskontrolle');
	await submitAndWait(page, 'group-create', '?/create');
	await expect(
		page.getByTestId(`group-row-grp-${suffix}`).locator('input[name="name.de"]')
	).toHaveValue('Zugriffskontrolle');

	await page.goto('/de/admin/controls/new');
	await page.getByTestId('control-slug').fill(`ctl-${suffix}`);
	await page.getByTestId('control-group').selectOption({ label: 'Zugriffskontrolle' });
	await page.getByTestId('control-create').click();
	await expect(page).toHaveURL(/\/admin\/controls\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('Mehr-Faktor-Authentifizierung');
	await submitAndWait(page, 'translation-save-de', '?/saveTranslation');

	await page.getByTestId('control-status').selectOption('implemented');
	await page.getByTestId('control-published').check();
	await submitAndWait(page, 'control-save-meta', '?/saveMeta');

	await page.goto('/de/controls');
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toBeVisible();
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toContainText('Umgesetzt');
});

test('an admin can publish a certification and see its badge on the landing page', async ({
	page
}) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/certifications/new');
	await page.getByTestId('certification-slug').fill(`cert-${suffix}`);
	await page.getByTestId('certification-framework').fill('ISO/IEC 27001:2022');
	await page.getByTestId('certification-issuer').fill('TÜV Süd');
	await page.getByTestId('certification-create').click();
	await expect(page).toHaveURL(/\/admin\/certifications\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-scope-de').fill('Betrieb der Plattform');
	await submitAndWait(page, 'translation-save-de', '?/saveTranslation');

	await page.getByTestId('certification-published').check();
	await submitAndWait(page, 'certification-save-meta', '?/saveMeta');

	await page.goto('/de');
	await expect(page.getByTestId(`certification-cert-${suffix}`)).toBeVisible();
	await expect(page.getByTestId(`certification-cert-${suffix}`)).toContainText(
		'Betrieb der Plattform'
	);
});

test('an admin can publish a subprocessor and see it on the portal', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/subprocessors/new');
	await page.getByTestId('subprocessor-slug').fill(`sub-${suffix}`);
	await page.getByTestId('subprocessor-name').fill('Hetzner Online GmbH');
	await page.getByTestId('subprocessor-legal-entity').fill('Hetzner Online GmbH');
	await page.getByTestId('subprocessor-country').fill('DE');
	await page.getByTestId('subprocessor-region').fill('EU');
	await page.getByTestId('subprocessor-create').click();
	await expect(page).toHaveURL(/\/admin\/subprocessors\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-purpose-de').fill('Hosting der Anwendung');
	await page.getByTestId('translation-datacategories-de').fill('Sämtliche Kundendaten');
	await submitAndWait(page, 'translation-save-de', '?/saveTranslation');

	await page.getByTestId('subprocessor-published').check();
	await submitAndWait(page, 'subprocessor-save-meta', '?/saveMeta');

	await page.goto('/de/subprocessors');
	const row = page.getByTestId(`subprocessor-sub-${suffix}`);
	await expect(row).toBeVisible();
	await expect(row).toContainText('Hosting der Anwendung');
	// Rendered through Intl.DisplayNames in the visitor's locale, not as "DE".
	await expect(row).toContainText('Deutschland');
});
