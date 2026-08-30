import { expect, test } from '@playwright/test';
import { and, eq, gte } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent, staffUser } from '../../src/lib/server/db/schema';
import { signInAs } from '../helpers/admin';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(() => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await closeDb();
});

/**
 * A staff identity outside the `admin<parallelIndex>` range every other spec
 * draws from, because this one disables it and a disabled account no other
 * test can stumble into is the whole point. The dev IdP synthesizes any
 * `admin<n>`; see tools/dev-idp/server.js.
 */
const DISABLED_ACCOUNT = 'admin999';

async function setDisabled(disabledAt: Date | null) {
	await db.update(staffUser).set({ disabledAt }).where(eq(staffUser.oidcSub, DISABLED_ACCOUNT));
}

test('a staff member disabled mid-session is refused at the route', async ({ page, context }) => {
	// Defensively, so a retry after a failed run does not start out locked out.
	await setDisabled(null);
	await signInAs(page, DISABLED_ACCOUNT);

	try {
		await setDisabled(new Date());

		// No sign-out, no expiry: the session is still live and the cookie still
		// in the jar. Only the route may refuse it.
		await page.goto('/admin');
		expect(page.url()).not.toContain('/admin');

		// And the cookie is gone — a `__Host-` cookie is only cleared by a
		// deletion whose attributes match the set exactly, so this fails if
		// STAFF_COOKIE_OPTIONS ever stops being shared between the two.
		const cookieNames = (await context.cookies()).map((cookie) => cookie.name);
		expect(cookieNames).not.toContain('__Host-tc_staff_session');
	} finally {
		await setDisabled(null);
	}
});

test('signing in again revokes the session held elsewhere', async ({ browser }) => {
	const first = await browser.newContext();
	const second = await browser.newContext();

	try {
		const firstPage = await first.newPage();
		await signInAs(firstPage, DISABLED_ACCOUNT);

		// A second sign-in as the same staff member, from another machine.
		await signInAs(await second.newPage(), DISABLED_ACCOUNT);

		await firstPage.goto('/admin');
		expect(firstPage.url()).not.toContain('/admin');
	} finally {
		await first.close();
		await second.close();
	}
});

test('a callback with no state cookie is refused and recorded', async ({ page }) => {
	const from = new Date(Date.now() - 5_000);

	// Straight to the callback, so neither `tc_oidc_state` nor `tc_oidc_verifier`
	// was ever set — the shape a replayed or forged callback link arrives in.
	const response = await page.goto('/auth/callback?code=forged&state=forged');
	expect(response?.status()).toBe(400);

	const failures = await db
		.select({ meta: auditEvent.meta })
		.from(auditEvent)
		.where(and(gte(auditEvent.at, from), eq(auditEvent.action, 'staff.login_failed')));

	expect(failures.map((row) => (row.meta as { reason?: string } | null)?.reason)).toContain(
		'state_mismatch'
	);
});
