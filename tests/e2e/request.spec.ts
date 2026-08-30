import { expect, test } from '@playwright/test';
import { desc, eq } from 'drizzle-orm';
import { requestTiers } from '../../src/lib/server/access/scope';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessRequest,
	auditEvent,
	outboundEmail,
	rateLimit
} from '../../src/lib/server/db/schema';

// The queue and the audit trail are the parts a browser cannot see, and they
// are the parts that matter: a request that renders a confirmation but queues
// no mail leaves the requester waiting forever. `DATABASE_URL` points at the
// suite's disposable database (tests/setup/e2e-db.ts).
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

// Every request in this file comes from the same address, and the submission
// limiter allows five per hour per address — correct in production, and enough
// to throttle this file into failing after its fifth test. Cleared per test so
// each one starts from a known state; the limiter itself has its own coverage
// in tests/integration/ratelimit.test.ts and in the case below.
test.beforeEach(async () => {
	await db.delete(rateLimit);
});

async function fillAndSubmit(page: import('@playwright/test').Page, email: string) {
	await page.goto('/de/request');
	await page.fill('input[name="email"]', email);
	await page.fill('input[name="name"]', 'E2E Person');
	await page.fill('input[name="company"]', 'Acme');
	await page.getByTestId('request-tier-request').check();
	await page.click('button[type="submit"]');
}

test('a visitor submits a request and is told to check their email', async ({ page }) => {
	await fillAndSubmit(page, `e2e-${Date.now()}@acme.example`);

	await expect(page.getByTestId('request-submitted')).toBeVisible();
});

test('the request form sets no cookie', async ({ page, context }) => {
	// A public route. Only the gated /access subtree may set a cookie, and the
	// portal's "sets no cookies" guarantee has to survive this phase.
	await page.goto('/de/request');
	expect(await context.cookies()).toHaveLength(0);

	await fillAndSubmit(page, `e2e-cookie-${Date.now()}@acme.example`);
	expect(await context.cookies()).toHaveLength(0);
});

test('an unknown and an already-seen email produce the same response', async ({ page }) => {
	// Spec §9.1's enumeration resistance, asserted on the rendered text.
	const email = `e2e-dup-${Date.now()}@acme.example`;

	await fillAndSubmit(page, email);
	const first = await page.getByTestId('request-submitted').textContent();

	await fillAndSubmit(page, email);
	const second = await page.getByTestId('request-submitted').textContent();

	expect(second).toBe(first);
});

test('the request form is not indexed and carries no canonical URL', async ({ page }) => {
	await page.goto('/de/request');

	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
	// A submission surface has nothing for a crawler to prefer.
	await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});

test('a malformed email is rejected without claiming anything was sent', async ({ page }) => {
	await page.goto('/de/request');
	// Bypass the browser's own validation so the server's is what answers.
	await page.locator('input[name="email"]').evaluate((node) => node.removeAttribute('type'));

	await page.fill('input[name="email"]', 'not-an-email');
	await page.fill('input[name="name"]', 'E2E Person');
	await page.fill('input[name="company"]', 'Acme');
	await page.getByTestId('request-tier-request').check();
	await page.click('button[type="submit"]');

	await expect(page.getByTestId('request-submitted')).toHaveCount(0);
});

test('a submission queues exactly one verification mail, in the page locale', async ({ page }) => {
	const email = `e2e-queue-${Date.now()}@acme.example`;
	await fillAndSubmit(page, email);
	await expect(page.getByTestId('request-submitted')).toBeVisible();

	const queued = await db.select().from(outboundEmail).where(eq(outboundEmail.to, email));

	expect(queued).toHaveLength(1);
	expect(queued[0]!.template).toBe('verify_request');
	// The page was German, so the mail is German.
	expect(queued[0]!.locale).toBe('de');
	// The link the requester will click, built from BASE_URL rather than the
	// request host, and carrying a token.
	expect(JSON.stringify(queued[0]!.payload)).toMatch(/\/de\/access\/verify\?token=/);
});

test('a submission records an audit event carrying no personal data', async ({ page }) => {
	const email = `e2e-audit-${Date.now()}@acme.example`;
	await fillAndSubmit(page, email);
	await expect(page.getByTestId('request-submitted')).toBeVisible();

	const [event] = await db
		.select()
		.from(auditEvent)
		.where(eq(auditEvent.action, 'access_request.submitted'))
		.orderBy(desc(auditEvent.seq))
		.limit(1);

	expect(event).toBeDefined();
	// Nobody has proven they control that address yet, so the actor is the
	// system rather than a requester.
	expect(event!.actorType).toBe('system');
	expect(event!.actorId).toBeNull();

	// Spec §10 confines requester personal data to ip, ua, and actor_id.
	const meta = JSON.stringify(event!.meta);
	expect(meta).not.toContain(email);
	expect(meta).not.toContain('Acme');
	expect(meta).not.toContain('E2E Person');
});

test('an unverified request holds the submission and names no requester', async ({ page }) => {
	const email = `e2e-row-${Date.now()}@acme.example`;
	await fillAndSubmit(page, email);
	await expect(page.getByTestId('request-submitted')).toBeVisible();

	const [row] = await db
		.select()
		.from(accessRequest)
		.where(eq(accessRequest.submittedEmail, email));

	expect(row).toBeDefined();
	expect(row!.status).toBe('unverified');
	expect(row!.requesterId).toBeNull();
	expect(await requestTiers(db, row!.id)).toEqual(['request']);
});

test('the form does not offer a tier this phase cannot honour', async ({ page }) => {
	// Not rendered at all rather than rendered-and-refused: `load` returns only
	// the tiers this phase honours, so there is no conditional to delete.
	await page.goto('/de/request');

	await expect(page.getByTestId('request-tier-request')).toBeVisible();
	await expect(page.getByTestId('request-tier-nda')).toHaveCount(0);
});

test('the submission limiter refuses a flood from one address', async ({ page }) => {
	// The limiter is a spec §10 requirement, and this is the only place it is
	// exercised through the real route rather than the module.
	for (let i = 0; i < 5; i++) {
		await fillAndSubmit(page, `e2e-flood-${Date.now()}-${i}@acme.example`);
		await expect(page.getByTestId('request-submitted')).toBeVisible();
	}

	await fillAndSubmit(page, `e2e-flood-${Date.now()}-last@acme.example`);

	await expect(page.getByTestId('request-submitted')).toHaveCount(0);
	await expect(page.getByText(/Zu viele Anfragen|Too many requests/)).toBeVisible();
});
