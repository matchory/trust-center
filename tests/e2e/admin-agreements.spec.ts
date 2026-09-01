import { expect, test } from '@playwright/test';
import { draftVersion, fillBody, gotoAdmin, signInAsAdmin, submitAndWait } from '../helpers/admin';
import { docxWith } from '../helpers/docx';
import { awaitHydration } from '../helpers/hydration';

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
	const url = (await draftVersion(page)).replace(/\/versions\/[0-9a-f-]{36}$/, '');

	// Refused at the form, not at render — the same discipline as RULE_PATTERN.
	await fillBody(page, 'de', '<script>alert(1)</script>');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await expect(page.getByTestId('body-not-in-subset')).toBeVisible();

	await fillBody(page, 'de', '# Vertrag\n\nText mit **fett**.');
	await fillBody(page, 'en', '# Agreement\n\nText with **bold**.');
	await submitAndWait(page, 'version-save', '?/saveBody');

	// The preview is the same renderer the requester gets.
	await expect(page.getByTestId('agreement-body').getByText('fett')).toBeVisible();

	await submitAndWait(page, 'version-publish', '?/publish');
	await gotoAdmin(page, url);
	await expect(page.getByTestId('agreement-effective-version')).toHaveText(/1/);
});

test('publishing is refused while a locale has no body', async ({ page }) => {
	await draftVersion(page);

	await fillBody(page, 'de', '# Nur Deutsch');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');

	await expect(page.getByTestId('version-incomplete')).toBeVisible();
});

test('a version cannot be published twice', async ({ page }) => {
	// `publishVersion` has no guard of its own against a second call — it would
	// only bump `effective_from` to a later timestamp and could reorder
	// `effectiveVersion`'s desc(effectiveFrom) precedence. The route refuses it.
	await draftVersion(page);

	await fillBody(page, 'de', '# Vertrag');
	await fillBody(page, 'en', '# Agreement');
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

test('an invalid body in one locale does not persist a valid body written to another', async ({
	page
}) => {
	// A per-locale write loop with no pre-validation could write the German
	// body, then throw on the English one and never reach `recordEvent` — a
	// persisted mutation with no audit event for it. Every submitted body is
	// validated before any of them is written, so a bad locale must leave
	// every locale exactly as it was.
	await draftVersion(page);

	await fillBody(page, 'de', '# Vertrag');
	await fillBody(page, 'en', '<script>alert(1)</script>');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await expect(page.getByTestId('body-not-in-subset')).toBeVisible();

	// Reload from the server: neither locale's body made it into the database.
	await gotoAdmin(page, page.url());
	await expect(page.getByTestId('body-de')).toHaveValue('');
	await expect(page.getByTestId('body-en')).toHaveValue('');
	await expect(page.getByTestId('agreement-body')).toHaveCount(0);
});

test('imports a docx into a draft body without saving it', async ({ page }) => {
	await gotoAdmin(page, await draftVersion(page));

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'nda.docx',
		mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		buffer: Buffer.from(
			docxWith([
				{ text: 'Vertraulichkeitsvereinbarung', heading: true },
				{ text: '1. Definitionen.' }
			])
		)
	});

	await submitAndWait(page, 'import-submit-de', '?/import');

	await expect(page.getByTestId('body-de')).toHaveValue(/Vertraulichkeitsvereinbarung/);

	// Import writes nothing (P3.22): a reload must show the body as it was.
	await page.reload();
	await awaitHydration(page);
	await expect(page.getByTestId('body-de')).not.toHaveValue(/Vertraulichkeitsvereinbarung/);
});

test('saves what was typed in the editor, and previews it from the server', async ({ page }) => {
	// The failure this guards is silent: a keystroke that never reaches the
	// hidden field produces a passing save over a body that was never written.
	await gotoAdmin(page, await draftVersion(page));

	const typed = `Geheimhaltung ${Date.now()}`;
	await page.getByTestId('body-de-editor').click();
	await page.keyboard.type(typed);

	await submitAndWait(page, 'version-save', '?/saveBody');
	await page.reload();
	await awaitHydration(page);

	// The server parsed it and rendered it back: the preview is the control
	// (§5.4), and it drawing the text is what proves the editor's document
	// reached the field the form posted.
	await expect(page.getByTestId('agreement-body').first()).toContainText(typed);

	// §14 asks for the journey through to publication, because a body that saves
	// but cannot be published is a body nobody can be asked to sign. A version is
	// effective only once every enabled locale has a body (§5.2).
	await page.getByTestId('body-en-editor').click();
	await page.keyboard.type(typed);
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');

	await expect(page.getByTestId('version-status')).toContainText(/effective|wirksam/i);
});

test('reports a node the server refuses, which the editor cannot show', async ({ page }) => {
	await gotoAdmin(page, await draftVersion(page));

	// Straight into the hidden field, which is what a paste of raw Markdown or a
	// client with the editor disabled produces. §5.1: the client schema is a
	// convenience, the server refusal is the control.
	await fillBody(page, 'de', '| a | b |\n| - | - |\n\n![x](https://example.test/x.png)');

	await submitAndWait(page, 'version-save', '?/saveBody');
	await expect(page.getByTestId('body-not-in-subset')).toBeVisible();
});
