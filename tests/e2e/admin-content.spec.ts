import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin, submitAndWait } from '../helpers/admin';

const suffix = Date.now().toString(36);

test('an admin can publish a control and see it on the portal', async ({ page }) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/controls/groups');
	await page.getByTestId('group-slug').fill(`grp-${suffix}`);
	await page.getByTestId('group-name-de').fill('Zugriffskontrolle');
	await submitAndWait(page, 'group-create', '?/create');
	await expect(
		page.getByTestId(`group-row-grp-${suffix}`).locator('input[name="name.de"]')
	).toHaveValue('Zugriffskontrolle');

	await gotoAdmin(page, '/de/admin/controls/new');
	await page.getByTestId('control-slug').fill(`ctl-${suffix}`);
	await page.getByTestId('control-group').selectOption({ label: 'Zugriffskontrolle' });
	await page.getByTestId('control-create').click();
	await expect(page).toHaveURL(/\/admin\/controls\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('Mehr-Faktor-Authentifizierung');
	await submitAndWait(page, 'translation-save', '?/saveTranslations');

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

	await gotoAdmin(page, '/de/admin/certifications/new');
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

	await gotoAdmin(page, '/de/admin/subprocessors/new');
	await page.getByTestId('subprocessor-slug').fill(`sub-${suffix}`);
	await page.getByTestId('subprocessor-name').fill('Hetzner Online GmbH');
	await page.getByTestId('subprocessor-legal-entity').fill('Hetzner Online GmbH');
	await page.getByTestId('subprocessor-country').fill('DE');
	await page.getByTestId('subprocessor-region').fill('EU');
	await page.getByTestId('subprocessor-create').click();
	await expect(page).toHaveURL(/\/admin\/subprocessors\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-purpose-de').fill('Hosting der Anwendung');
	await page.getByTestId('translation-datacategories-de').fill('Sämtliche Kundendaten');
	await submitAndWait(page, 'translation-save', '?/saveTranslations');

	await page.getByTestId('subprocessor-published').check();
	await submitAndWait(page, 'subprocessor-save-meta', '?/saveMeta');

	await page.goto('/de/subprocessors');
	const row = page.getByTestId(`subprocessor-sub-${suffix}`);
	await expect(row).toBeVisible();
	await expect(row).toContainText('Hosting der Anwendung');
	// Rendered through Intl.DisplayNames in the visitor's locale, not as "DE".
	await expect(row).toContainText('Deutschland');
});

test('an answer stays off the FAQ until it is made public', async ({ page }) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/faq/new');
	await page.getByTestId('answer-slug').fill(`faq-${suffix}`);
	await page.getByTestId('answer-category').fill('infrastructure');
	await page.getByTestId('answer-create').click();
	await expect(page).toHaveURL(/\/admin\/faq\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-question-de').fill('Wo werden die Daten gehostet?');
	await page.getByTestId('translation-answer-de').fill('In Deutschland, bei Hetzner.');
	await submitAndWait(page, 'translation-save', '?/saveTranslations');

	// Answers start internal, so a translated answer is still not on the portal.
	await page.goto('/de/faq');
	await expect(page.getByTestId(`answer-faq-${suffix}`)).toHaveCount(0);

	await page.goBack();
	await page.getByTestId('answer-visibility').selectOption('public');
	await submitAndWait(page, 'answer-save-meta', '?/saveMeta');

	await page.goto('/de/faq');
	await expect(page.getByTestId(`answer-faq-${suffix}`)).toContainText(
		'In Deutschland, bei Hetzner.'
	);
});

test('an update reaches the feed only once it carries a publication date', async ({ page }) => {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/updates/new');
	await page.getByTestId('update-slug').fill(`upd-${suffix}`);
	await page.getByTestId('update-kind').selectOption('advisory');
	await page.getByTestId('update-create').click();
	await expect(page).toHaveURL(/\/admin\/updates\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('Neuer Unterauftragsverarbeiter');
	await page.getByTestId('translation-body-de').fill('Wir haben Hetzner aufgenommen.');
	await submitAndWait(page, 'translation-save', '?/saveTranslations');

	// A translated post with no date is still a draft.
	await page.goto('/de/updates');
	await expect(page.getByTestId(`update-upd-${suffix}`)).toHaveCount(0);

	await page.goBack();
	await page.getByTestId('update-published-at').fill('2026-06-01T09:00');
	await submitAndWait(page, 'update-save-meta', '?/saveMeta');

	await page.goto('/de/updates');
	await expect(page.getByTestId(`update-upd-${suffix}`)).toContainText(
		'Neuer Unterauftragsverarbeiter'
	);
});
