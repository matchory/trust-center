import { expect, test } from '@playwright/test';

// The dev-IdP's built-in `devInteractions` login screen (node-oidc-provider)
// renders unlabelled inputs — no <label> or aria-label, only placeholder
// text — so `getByLabel` cannot find them. Selectors below were captured by
// inspecting the rendered form at http://localhost:5556/interaction/<uid>
// (also reproducible with `pnpm exec playwright codegen
// http://localhost:5556`): a `login` field with placeholder "Enter any
// login", a `password` field with placeholder "and password", and a
// "Sign-in" submit button. A second "Authorize" screen follows with a lone
// "Continue" button.
async function signIn(page: import('@playwright/test').Page, account: string) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill(account);
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) {
		await consent.click();
	}
}

test('redirects an anonymous visitor away from the admin area', async ({ page }) => {
	const response = await page.goto('/admin');
	expect(page.url()).not.toContain('/admin');
	expect(response?.status()).toBeLessThan(400);
});

test('an admin can sign in and reach the admin area', async ({ page }) => {
	await signIn(page, 'admin');

	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByTestId('staff-email')).toHaveText('admin@example.test');
	await expect(page.getByTestId('staff-role')).toHaveText('admin');
});

test('a user in no mapped group is refused', async ({ page }) => {
	await signIn(page, 'nobody');

	await expect(page.getByText(/not a member of a group authorised/i)).toBeVisible();
});

test('signing out revokes the session immediately', async ({ page }) => {
	await signIn(page, 'admin');
	await expect(page).toHaveURL(/\/admin$/);

	await page.getByTestId('sign-out').click();

	await page.goto('/admin');
	expect(page.url()).not.toContain('/admin');
});
