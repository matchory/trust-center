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

test('a body is previewed before it can be published, and a bad body is refused', async ({
	page
}) => {
	await signInAsAdmin(page);

	const slug = `preview-${Date.now()}`;
	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(slug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');

	// `submitAndWait` only waits for the POST response, not the client-side
	// redirect `use:enhance` follows after it — reading `page.url()` right
	// after would race that navigation and capture the "new" page's URL.
	await expect(page).toHaveURL(/\/admin\/agreements\/[0-9a-f-]{36}$/);
	const url = page.url();
	await submitAndWait(page, 'agreement-new-version', '?/createVersion');
	await page.getByTestId('version-1').click();

	// Refused at the form, not at render — the same discipline as RULE_PATTERN.
	await page.getByTestId('body-de').fill('<script>alert(1)</script>');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await expect(page.getByTestId('body-not-in-subset')).toBeVisible();

	await page.getByTestId('body-de').fill('# Vertrag\n\nText mit **fett**.');
	await page.getByTestId('body-en').fill('# Agreement\n\nText with **bold**.');
	await submitAndWait(page, 'version-save', '?/saveBody');

	// The preview is the same renderer the requester gets.
	await expect(page.getByTestId('agreement-body').getByText('fett')).toBeVisible();

	await submitAndWait(page, 'version-publish', '?/publish');
	await gotoAdmin(page, url);
	await expect(page.getByTestId('agreement-effective-version')).toHaveText(/1/);
});

test('publishing is refused while a locale has no body', async ({ page }) => {
	await signInAsAdmin(page);

	const slug = `partial-${Date.now()}`;
	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(slug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');
	await submitAndWait(page, 'agreement-new-version', '?/createVersion');
	await page.getByTestId('version-1').click();

	await page.getByTestId('body-de').fill('# Nur Deutsch');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');

	await expect(page.getByTestId('version-incomplete')).toBeVisible();
});

test('a version cannot be published twice', async ({ page }) => {
	// `publishVersion` has no guard of its own against a second call — it would
	// only bump `effective_from` to a later timestamp and could reorder
	// `effectiveVersion`'s desc(effectiveFrom) precedence. The route refuses it.
	await signInAsAdmin(page);

	const slug = `republish-${Date.now()}`;
	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(slug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');
	await submitAndWait(page, 'agreement-new-version', '?/createVersion');
	await page.getByTestId('version-1').click();

	await page.getByTestId('body-de').fill('# Vertrag');
	await page.getByTestId('body-en').fill('# Agreement');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');

	// `submitAndWait` only waits for the network response, not for `use:enhance`'s
	// client-side settle (`invalidateAll` + `applyAction`) that follows it. Firing
	// the second submit before that settle finishes races the two `applyAction`
	// calls; waiting for the effective badge here is what makes the second submit
	// see a version that is unambiguously already published.
	await expect(page.getByTestId('version-status')).toHaveText(/wirksam/);

	await submitAndWait(page, 'version-publish', '?/publish');
	await expect(page.getByTestId('version-already-published')).toBeVisible();
});
