import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { eq, like, not } from 'drizzle-orm';
import { accessRequest, outboundEmail, rateLimit } from '../../src/lib/server/db/schema';
import { awaitHydration } from './hydration';
import type { Db } from '../../src/lib/server/db';

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

/**
 * `use:enhance` submits over fetch, so a `page.goto` fired straight after a
 * click can outrun the action. Wait for the POST to come back before asserting
 * on anything the action wrote.
 *
 * Here rather than in a spec for the same reason as `signInAs`: Playwright
 * refuses to let one test file import another, so each spec that needed this
 * was inlining its own copy.
 */
export async function submitAndWait(page: Page, testId: string, action: string) {
	await Promise.all([
		page.waitForResponse(
			(response) => response.request().method() === 'POST' && response.url().includes(action)
		),
		page.getByTestId(testId).click()
	]);
}

/**
 * An operator publishes an agreement, files a `request`-tier document behind a
 * group carrying it; a prospect then requests that document and verifies.
 * Leaves a pending request whose proposal names exactly that one agreement.
 *
 * It drives the real admin forms rather than inserting rows, because what the
 * cases built on it assert is that an operator can *reach* this state — and
 * every admin step goes through `gotoAdmin`, so no interaction lands before
 * hydration. Here rather than in a spec for the same reason as `signInAs`:
 * Playwright refuses to let one test file import another, and two specs need
 * this one.
 *
 * The caller signs in first, and owns the `db` handle. The verification token
 * is read out of the `outbound_email` queue rather than out of Mailpit, the way
 * `access-journey.spec.ts` already does — the mail is queued rather than sent
 * inline, so going through a mail server would buy flakiness for nothing.
 */
export async function seedRequestForAgreement(
	page: Page,
	db: Db
): Promise<{
	requestId: string;
	documentId: string;
	documentSlug: string;
	agreementSlug: string;
	email: string;
}> {
	const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const agreementSlug = `nda-${stamp}`;
	const groupSlug = `pack-${stamp}`;
	const categorySlug = `cat-${stamp}`;
	const documentSlug = `doc-${stamp}`;

	// 1. An agreement, named so the approver's requirement list is readable.
	await gotoAdmin(page, '/de/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(agreementSlug);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');
	await expect(page).toHaveURL(/\/admin\/agreements\/[0-9a-f-]{36}$/);
	const agreementUrl = page.url();

	await page.getByTestId('agreement-name-de').fill(`Vereinbarung ${stamp}`);
	await page.getByTestId('agreement-name-en').fill(`Agreement ${stamp}`);
	await submitAndWait(page, 'agreement-save-translations', '?/saveTranslations');

	// 2. A version with a body in every enabled locale, published — nothing else
	// makes it renderable, and an unrenderable agreement cannot be required.
	await submitAndWait(page, 'agreement-new-version', '?/createVersion');
	await page.getByTestId('version-1').click();
	await page.getByTestId('body-de').fill('# Vertrag\n\nGeheimhaltung.');
	await page.getByTestId('body-en').fill('# Agreement\n\nConfidentiality.');
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');
	await gotoAdmin(page, agreementUrl);
	await expect(page.getByTestId('agreement-effective-version')).toHaveText(/1/);

	// 3. A group carrying it.
	await gotoAdmin(page, '/de/admin/groups');
	await page.getByTestId('group-slug').fill(groupSlug);
	await submitAndWait(page, 'group-create', '?/create');
	await page.getByTestId(`group-row-${groupSlug}`).getByRole('link').click();
	await awaitHydration(page);
	await page.getByTestId('group-agreement').selectOption({ label: `Vereinbarung ${stamp}` });
	await submitAndWait(page, 'group-save-meta', '?/saveMeta');

	// 4. A published `request`-tier document filed into that group.
	await gotoAdmin(page, '/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(categorySlug);
	await page.getByTestId('category-name-de').fill(`Kategorie ${stamp}`);
	await page.getByTestId('category-name-en').fill(`Category ${stamp}`);
	await submitAndWait(page, 'category-create', '?/create');

	await gotoAdmin(page, '/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(documentSlug);
	await page.getByTestId('document-category').selectOption({ label: `Kategorie ${stamp}` });
	await page.getByTestId('document-tier').selectOption('request');
	await submitAndWait(page, 'document-create', '/admin/documents/new');
	await expect(page).toHaveURL(/\/admin\/documents\/[0-9a-f-]{36}$/);
	const documentId = page.url().split('/').pop()!;

	// Membership is edited from the document, per Phase 3a.
	await page.getByTestId(`document-group-${groupSlug}`).check();
	await submitAndWait(page, 'document-save', '?/saveMeta');
	await submitAndWait(page, 'document-publish', '?/setStatus');

	// 5. The prospect submits for that one document, on a domain no rule
	// matches, so the request lands in the queue rather than auto-approving.
	const email = `nda-${stamp}@nomatch-${stamp}.example`;

	// The submission limiter allows five per hour per *client address* as well
	// as per email, and every spec in a run shares one. Reset it the way
	// `request.spec.ts` and `access-journey.spec.ts` already do — without this
	// the helper passes alone and fails in a full run.
	//
	// Every address bucket, and nothing else. A full run submits far more than
	// the five-per-hour the address limiter allows, so specs must clear it. The
	// email buckets are spared because the flood case below asserts one of
	// them, and a delete landing mid-flood is what made that case fail only in
	// full runs.
	await db.delete(rateLimit).where(not(like(rateLimit.key, 'request:email:%')));

	await page.goto('/de/request');
	await awaitHydration(page);
	await page.fill('input[name="email"]', email);
	await page.fill('input[name="name"]', 'E2E Person');
	await page.fill('input[name="company"]', 'Acme');
	await page.check(`input[name="documentIds"][value="${documentId}"]`);
	await page.click('button[type="submit"]');
	await expect(page.getByTestId('request-submitted')).toBeVisible();

	// Read before verifying: verification moves the address onto the requester
	// and clears `submitted_email`, so this is the only window it identifies the
	// row in.
	const [submitted] = await db
		.select({ id: accessRequest.id })
		.from(accessRequest)
		.where(eq(accessRequest.submittedEmail, email));
	if (!submitted) throw new Error('the submission produced no request row');

	// 6. Verify by the queued magic link.
	const [queued] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, email));
	const linkUrl = String((queued?.payload as { url?: string } | null)?.url ?? '');
	const token = new URL(linkUrl).searchParams.get('token');
	if (!token) throw new Error('no verification token was queued');

	await page.goto(`/de/access/verify?token=${encodeURIComponent(token)}`);
	await awaitHydration(page);
	await page.getByTestId('verify-confirm').click();
	await expect(page).toHaveURL(/\/de\/access$/);

	const [request] = await db
		.select({ status: accessRequest.status })
		.from(accessRequest)
		.where(eq(accessRequest.id, submitted.id));

	// No rule matches the generated domain, so rule evaluation leaves it in the
	// queue — which is the state these cases exist to decide.
	if (request?.status !== 'pending') {
		throw new Error(`fixture request is not pending — got ${request?.status}`);
	}

	return { requestId: submitted.id, documentId, documentSlug, agreementSlug, email };
}

/**
 * Signs in, creates an agreement, adds a version, and returns the version
 * editor's URL.
 *
 * Extracted rather than copied: it is a nine-step setup that four cases in
 * `admin-agreements.spec.ts` and two in `admin-upload.spec.ts` need, and a
 * second copy is how two specs come to disagree about what a draft version is.
 * Here rather than in a spec for the same reason as `signInAs`: Playwright
 * refuses to let one test file import another.
 */
export async function draftVersion(page: Page): Promise<string> {
	await signInAsAdmin(page);

	await gotoAdmin(page, '/admin/agreements/new');
	await page.getByTestId('agreement-slug').fill(`draft-${Date.now()}-${randomUUID().slice(0, 8)}`);
	await submitAndWait(page, 'agreement-create', '/admin/agreements/new');

	// `submitAndWait` only waits for the POST response, not the client-side
	// redirect `use:enhance` follows after it — reading `page.url()` right after
	// would race that navigation and capture the "new" page's URL.
	await expect(page).toHaveURL(/\/admin\/agreements\/[0-9a-f-]{36}$/);

	await submitAndWait(page, 'agreement-new-version', '?/createVersion');
	await page.getByTestId('version-1').click();

	// The click is a client-side navigation, and `networkidle` can be satisfied
	// before the router has swapped the URL — reading `page.url()` then returns
	// the agreement page and every caller loads the wrong page.
	await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
	await awaitHydration(page);

	return page.url();
}
