import { expect, test } from '@playwright/test';

test('every portal page carries a canonical URL and one alternate per locale', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/de\/documents$/);
	await expect(page.locator('link[rel="alternate"][hreflang="de"]')).toHaveAttribute(
		'href',
		/\/de\/documents$/
	);
	await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
		'href',
		/\/en\/documents$/
	);
	// x-default points at the deployment's default locale, so a crawler with
	// no language preference is sent somewhere deterministic.
	await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
		'href',
		/\/de\/documents$/
	);
});

test('portal pages carry Open Graph metadata', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
	await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'de');
	await expect(page.locator('meta[name="description"]')).toHaveCount(1);
});

test('the admin area is noindex', async ({ page }) => {
	// Signed in, because an anonymous visitor is redirected to the portal and
	// would be asserted against the wrong page.
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	const response = await page.goto('/de/admin');

	expect(response?.headers()['x-robots-tag']).toMatch(/noindex/);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('robots.txt disallows the admin area and names the sitemap', async ({ request }) => {
	const response = await request.get('/robots.txt');
	const body = await response.text();

	expect(body).toMatch(/Disallow: \/admin/);
	expect(body).toMatch(/Disallow: \/api/);
	expect(body).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
});

test('the sitemap lists every locale of every published section', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();

	expect(body).toContain('<urlset');
	expect(body).toMatch(/<loc>[^<]*\/de\/documents<\/loc>/);
	expect(body).toMatch(/<loc>[^<]*\/en\/documents<\/loc>/);
	expect(body).toMatch(/hreflang="en"/);
});
