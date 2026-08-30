import { expect, type Page } from '@playwright/test';

/**
 * Signs in through the dev IdP as one of its fixture accounts. Lives here
 * rather than in a spec because Playwright refuses to let one test file import
 * another.
 */
async function signIn(page: Page, account: 'admin' | 'approver') {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill(account);
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	await expect(page).toHaveURL(/\/admin$/);
}

export async function signInAsAdmin(page: Page) {
	await signIn(page, 'admin');
}

export async function signInAsApprover(page: Page) {
	await signIn(page, 'approver');
}
