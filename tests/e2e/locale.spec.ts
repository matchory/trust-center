import { expect, test } from '@playwright/test';

test('serves German at the default root', async ({ page }) => {
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
