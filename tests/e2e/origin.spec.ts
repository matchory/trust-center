import { expect, test } from '@playwright/test';

/**
 * This project's server is configured with BASE_URL=https://trust.example.test
 * while listening on http://localhost:4174. Every assertion here fails if any
 * of these values is derived from the request host instead of the configured
 * origin — which is exactly the bug b72f18c fixed and that no single-origin
 * test could have caught.
 */
const CONFIGURED = 'https://trust.example.test';

test('canonical URL comes from BASE_URL, not the request host', async ({ page }) => {
	await page.goto('/de');

	const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
	expect(canonical).toBe(`${CONFIGURED}/de`);
});

test('hreflang alternates come from BASE_URL', async ({ page }) => {
	await page.goto('/de');

	const alternates = await page
		.locator('link[rel="alternate"]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));

	expect(alternates.length).toBeGreaterThan(0);
	for (const href of alternates) expect(href).toContain(CONFIGURED);
});

test('Open Graph URL comes from BASE_URL', async ({ page }) => {
	await page.goto('/de');

	const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
	expect(ogUrl).toContain(CONFIGURED);
});

test('the sitemap lists BASE_URL origins and never the listen address', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();

	expect(body).toContain(`${CONFIGURED}/`);
	expect(body).not.toContain('localhost:4174');
});

test('robots.txt names the sitemap at BASE_URL', async ({ request }) => {
	const body = await (await request.get('/robots.txt')).text();

	expect(body).toContain(`${CONFIGURED}/sitemap.xml`);
});
