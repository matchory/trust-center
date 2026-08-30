import { expect, test, type Page } from '@playwright/test';

/**
 * The dev IdP's fixture identity for this Playwright slot — `admin0`,
 * `approver3`, and so on. Signing in revokes every other live session for that
 * staff member (`revokeAllStaffSessions`, a deliberate security property), so
 * two workers sharing one account revoke each other mid-test. `parallelIndex`
 * is bounded by the worker count and never held by two workers at once, which
 * is exactly the isolation needed. See tools/dev-idp/server.js.
 *
 * `tests/e2e/auth.spec.ts` deliberately keeps using the plain `admin` account:
 * it is the spec that exercises the login flow itself, its cases run serially
 * in one worker, and nothing else claims that identity any more.
 */
function slotAccount(role: 'admin' | 'approver'): string {
	return `${role}${test.info().parallelIndex}`;
}

/**
 * Signs in through the dev IdP as a named fixture account. Lives here rather
 * than in a spec because Playwright refuses to let one test file import
 * another.
 */
export async function signInAs(page: Page, account: string) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill(account);
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	// Well past the 5s default: signing in is three cross-origin navigations
	// plus a token exchange, and the first test of a run pays the preview
	// server's cold start on top. Timing out here reads as a broken guard when
	// it is only a slow one, which is how this flaked under load before.
	await expect(page).toHaveURL(/\/admin$/, { timeout: 20_000 });
}

export async function signInAsAdmin(page: Page) {
	await signInAs(page, slotAccount('admin'));
}

export async function signInAsApprover(page: Page) {
	await signInAs(page, slotAccount('approver'));
}

/**
 * Waits for the page's JavaScript to have loaded and run, which is when Svelte
 * claims the server-rendered tree.
 *
 * Filling a field before that point is a race the test loses silently: an input
 * rendered as `value={data.x}` has its DOM value written again during
 * hydration, discarding whatever Playwright typed, and the form then submits
 * the server's value as if the test had never touched it — a pass on the
 * visible "saved" state and a wrong row in the database. `networkidle` is the
 * signal because hydration runs inside the entry module, so once no request has
 * been in flight for half a second the chunks are loaded and hydration is done.
 *
 * The same hazard exists on every admin form. It is applied where it has
 * actually been observed rather than pre-emptively everywhere.
 */
export async function awaitHydration(page: Page) {
	await page.waitForLoadState('networkidle');
}

/**
 * Navigates to an admin page and waits for it to be interactive.
 *
 * Every admin spec goes through this rather than `page.goto`, so no spec can
 * reach a form before Svelte has claimed it — see `awaitHydration` for what
 * goes wrong when one does, and note that the failure is a test that passes
 * while writing the wrong row rather than one that fails.
 */
export async function gotoAdmin(page: Page, path: string) {
	const response = await page.goto(path);
	await awaitHydration(page);
	return response;
}
