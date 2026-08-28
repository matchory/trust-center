import { expect, test } from '@playwright/test';

test('renders German at the unprefixed root for a German-preferring browser', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('serves English under the /en prefix', async ({ page }) => {
	await page.goto('/en');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('sets no cookies on the public portal', async ({ page, context }) => {
	await page.goto('/');
	expect(await context.cookies()).toHaveLength(0);
});

test('negotiates the locale from Accept-Language at the unprefixed root', async ({ browser }) => {
	// Two independent browser contexts with different preferred languages,
	// both requesting the same unprefixed URL, must render different content.
	// This is the only test that actually exercises the Accept-Language
	// wiring end-to-end: with the suite's `use.locale` pinned to `de-DE` for
	// determinism, every other test would still pass even if the
	// Accept-Language branch in hooks.server.ts were deleted outright.
	const deContext = await browser.newContext({ locale: 'de-DE' });
	const enContext = await browser.newContext({ locale: 'en-GB' });

	try {
		const dePage = await deContext.newPage();
		const enPage = await enContext.newPage();

		await dePage.goto('/');
		await enPage.goto('/');

		await expect(dePage.getByTestId('admin-link-label')).toHaveText('Verwaltung');
		await expect(enPage.getByTestId('admin-link-label')).toHaveText('Administration');

		await expect(dePage.locator('html')).toHaveAttribute('lang', 'de');
		await expect(enPage.locator('html')).toHaveAttribute('lang', 'en');
	} finally {
		await deContext.close();
		await enContext.close();
	}
});

test('updates rendered messages on client-side navigation between locale prefixes', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');

	// Plant a marker on `window` and a real in-app link before navigating.
	// A full document reload would reset `window` state entirely, so the
	// marker surviving the click is proof this was a client-side navigation
	// handled by SvelteKit's router, not a full page load.
	await page.evaluate(() => {
		(window as unknown as { __navMarker?: boolean }).__navMarker = true;

		const anchorPoint = document.querySelector('[data-testid="admin-link-label"]');
		const link = document.createElement('a');
		link.href = '/en';
		link.textContent = 'switch to English';
		anchorPoint?.after(link);
	});

	await page.getByRole('link', { name: 'switch to English' }).click();

	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	const markerSurvived = await page.evaluate(
		() => (window as unknown as { __navMarker?: boolean }).__navMarker
	);
	expect(markerSurvived).toBe(true);
});
