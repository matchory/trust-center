import { expect, test } from '@playwright/test';

test('redirects the unprefixed root to the negotiated locale', async ({ browser }) => {
	// Two contexts with different preferred languages requesting the same URL
	// must land on different locale prefixes. This is the only test exercising
	// the Accept-Language wiring end to end: the suite pins `use.locale` to
	// de-DE for determinism, so every other test would still pass if the
	// negotiation branch were deleted outright.
	const deContext = await browser.newContext({ locale: 'de-DE' });
	const enContext = await browser.newContext({ locale: 'en-GB' });

	try {
		const dePage = await deContext.newPage();
		const enPage = await enContext.newPage();

		await dePage.goto('/');
		await enPage.goto('/');

		await expect(dePage).toHaveURL(/\/de$/);
		await expect(enPage).toHaveURL(/\/en$/);
	} finally {
		await deContext.close();
		await enContext.close();
	}
});

test('marks the negotiated redirect as varying by Accept-Language', async ({ request }) => {
	// Without this header a cache in front of the app would serve one visitor's
	// negotiated redirect to every other visitor.
	const response = await request.get('/', { maxRedirects: 0 });
	expect(response.status()).toBe(302);
	expect(response.headers()['vary']).toMatch(/accept-language/i);
});

test('serves German under /de and English under /en', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');

	await page.goto('/en');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('sets no cookies on the public portal', async ({ page, context }) => {
	await page.goto('/de');
	expect(await context.cookies()).toHaveLength(0);
});

test('falls through an uncompiled prefix to ordinary routing, which 404s', async ({ page }) => {
	// "/fr" has no compiled catalog, so classifyPath treats it as an ordinary,
	// unprefixed path rather than a locale — it is NOT the "compiled but
	// disabled" case (that 404 is covered directly, at the `handle` hook
	// level, by tests/unit/hooks-locale.test.ts, since no combination of
	// LOCALES this suite runs against ever disables a compiled locale). The
	// root layout's negotiating redirect then prefixes it to "/de/fr", which
	// matches no route and 404s the ordinary way. This test only proves that
	// fallthrough, not the dedicated unknown-locale branch in hooks.server.ts.
	const response = await page.goto('/fr');
	expect(response?.status()).toBe(404);
});

test('updates rendered messages on client-side navigation between locales', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');

	// Plant a marker on `window` before navigating. A full document reload
	// resets `window`, so the marker surviving the click proves SvelteKit's
	// client router handled the navigation. Only `window` is touched, never the
	// DOM: an element injected before hydration is liable to be reconciled away
	// when Svelte claims the tree, which is a race, not a test.
	await page.evaluate(() => {
		(window as unknown as { __navMarker?: boolean }).__navMarker = true;
	});

	// The portal's own locale switcher, so the link under test is one the app
	// actually ships rather than one the test invented.
	await page.getByTestId('locale-switch-en').click();

	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	const markerSurvived = await page.evaluate(
		() => (window as unknown as { __navMarker?: boolean }).__navMarker
	);
	expect(markerSurvived).toBe(true);
});
