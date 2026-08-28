import { expect, test } from '@playwright/test';

test('renders the portal shell with a skip link and a footer', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('skip-to-content')).toBeAttached();
	await expect(page.getByTestId('portal-footer')).toBeVisible();
});

test('the locale switcher preserves the current path', async ({ page }) => {
	await page.goto('/de');
	await page.getByTestId('locale-switch-en').click();
	await expect(page).toHaveURL(/\/en$/);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('offers one locale switch link per enabled locale, naming each in its own language', async ({
	page
}) => {
	await page.goto('/de');
	await expect(page.getByTestId('locale-switch-de')).toHaveText('Deutsch');
	await expect(page.getByTestId('locale-switch-en')).toHaveText('English');
});

test('marks the active locale so it is not announced as a link to elsewhere', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('locale-switch-de')).toHaveAttribute('aria-current', 'true');
});
