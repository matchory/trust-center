import { expect, test } from '@playwright/test';
import { desc, gte } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent } from '../../src/lib/server/db/schema';

// Regression coverage for the two behaviours this product most exists to
// guarantee — instant server-side revocation and an audit trail — needs to
// read the real audit_event table, hence a direct DB connection here rather
// than only asserting on browser-visible state. `DATABASE_URL` is loaded via
// `test:e2e`'s `--env-file-if-exists=.env` (see package.json), pointing at
// the same dev Postgres docker-compose.dev.yml starts.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error(
		'DATABASE_URL is not set — the e2e suite asserts against the real audit_event ' +
			"table and needs it (see .env.example, and package.json's test:e2e script)."
	);
}
let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(() => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await closeDb();
});

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

	// Started before the form is even filled in — Playwright's `response`
	// listener is attached to the page immediately and survives the
	// subsequent same-page navigations, so it reliably observes whichever
	// later action actually triggers the callback request instead of racing
	// it. Returned so callers can assert on the callback's status.
	const callbackResponse = page.waitForResponse((response) =>
		response.url().includes('/auth/callback')
	);

	await page.getByPlaceholder('Enter any login').fill(account);
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) {
		await consent.click();
	}

	return callbackResponse;
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
	const response = await signIn(page, 'nobody');

	expect(response.status()).toBe(403);
	await expect(page.getByText(/not a member of a group authorised/i)).toBeVisible();

	// The dev-IdP itself sets its own `_interaction`/`_session.legacy`
	// cookies on the shared `localhost` domain (cookies aren't port-scoped),
	// so asserting zero cookies in the context would fail for reasons
	// unrelated to our guard. What must not exist is *our* session cookie —
	// its absence proves no session was created before the role check ran.
	const cookieNames = (await page.context().cookies()).map((cookie) => cookie.name);
	expect(cookieNames).not.toContain('tc_staff_session');
});

test('signing out revokes the session immediately, at the server', async ({ page, context }) => {
	await signIn(page, 'admin');
	await expect(page).toHaveURL(/\/admin$/);

	const sessionCookie = (await context.cookies()).find(
		(cookie) => cookie.name === 'tc_staff_session'
	);
	if (!sessionCookie) throw new Error('expected a tc_staff_session cookie after signing in');

	await page.getByTestId('sign-out').click();

	await page.goto('/admin');
	expect(page.url()).not.toContain('/admin');

	// Re-add the cookie the browser just cleared and request /admin again.
	// This proves the session was revoked SERVER-SIDE: if `revokeStaffSession`
	// were ever deleted, the cookie alone would still get the visitor into
	// /admin, since the browser-cleared cookie no longer matters once we
	// hand the old value back ourselves.
	await context.addCookies([sessionCookie]);
	await page.goto('/admin');
	expect(page.url()).not.toContain('/admin');
});

test('records a succeeded login, a logout, and a denied login in the audit trail', async ({
	page,
	browser
}) => {
	// A small grace period rather than `new Date()` exactly at test start,
	// in case the test runner's and the database container's clocks skew.
	const from = new Date(Date.now() - 5_000);

	await signIn(page, 'admin');
	await expect(page).toHaveURL(/\/admin$/);
	await page.getByTestId('sign-out').click();
	await expect(page).toHaveURL(/\/de$/);

	const deniedContext = await browser.newContext();
	try {
		const deniedPage = await deniedContext.newPage();
		const deniedResponse = await signIn(deniedPage, 'nobody');
		expect(deniedResponse.status()).toBe(403);
	} finally {
		await deniedContext.close();
	}

	const recent = await db
		.select({ action: auditEvent.action })
		.from(auditEvent)
		.where(gte(auditEvent.at, from))
		.orderBy(desc(auditEvent.seq));
	const actions = recent.map((row) => row.action);

	expect(actions).toContain('staff.login.succeeded');
	expect(actions).toContain('staff.logout');
	expect(actions).toContain('staff.login.denied');
});
