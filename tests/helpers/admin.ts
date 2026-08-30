import { expect, type Page } from '@playwright/test';

/**
 * Signs in through the dev IdP. Lives here rather than in a spec because
 * Playwright refuses to let one test file import another.
 */
export async function signInAsAdmin(page: Page) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	await expect(page).toHaveURL(/\/admin$/);
}
