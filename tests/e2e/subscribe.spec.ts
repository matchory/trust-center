import { expect, test } from '@playwright/test';
import { and, desc, eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { outboundEmail, subscription } from '../../src/lib/server/db/schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(() => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await closeDb();
});

async function lastMailUrl(to: string, template: string): Promise<string> {
	// Filtered by template, not just by recipient: this spec queues several
	// kinds of mail to one address, and "the newest row" would silently follow
	// the wrong link the moment the order changes.
	const [row] = await db
		.select({ payload: outboundEmail.payload })
		.from(outboundEmail)
		.where(and(eq(outboundEmail.to, to), eq(outboundEmail.template, template)))
		.orderBy(desc(outboundEmail.createdAt));
	if (!row) throw new Error(`no ${template} mail queued for ${to}`);
	const payload = row.payload as { url?: string };
	if (!payload.url) throw new Error(`${template} mail carried no url`);
	return payload.url;
}

test('subscribe, confirm, manage, unsubscribe', async ({ page }) => {
	const email = `e2e-${Date.now()}@example.test`;

	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-advisory').check();
	await page.getByTestId('subscribe-submit').click();
	await expect(page.getByTestId('subscribe-submitted')).toBeVisible();

	const confirmUrl = await lastMailUrl(email, 'subscription_confirm');

	// P4.3, and the assertion that would catch a future refactor turning this
	// page back into a mutation: a mail scanner's GET must confirm nothing.
	await page.goto(confirmUrl);
	let [row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row?.confirmedAt, 'a GET must not confirm').toBeNull();

	await page.getByTestId('confirm-submit').click();
	await expect(page.getByTestId('confirm-done')).toBeVisible();
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row?.confirmedAt).not.toBeNull();

	const manageUrl = `/de/subscribe/manage?token=${encodeURIComponent(row!.manageToken!)}`;
	await page.goto(manageUrl);
	await expect(page.getByTestId('manage-topic-advisory')).toBeChecked();

	// Spec §10.3's no-cookie guarantee, pinned here rather than in
	// security.spec.ts's path loop: that loop asserts a 200, and a tokenless
	// manage URL 404s — this is the one place the page actually renders with a
	// valid token, which is the case worth guarding.
	expect(await page.context().cookies(), 'the manage page must set no cookie').toHaveLength(0);

	await page.getByTestId('manage-topic-document').check();
	await page.getByTestId('manage-save').click();
	await expect(page.getByTestId('manage-topic-document')).toBeChecked();

	// The same rule as the subscribe form: a save with no topics is refused
	// rather than silently treated as an unsubscribe (spec §5).
	await page.getByTestId('manage-topic-advisory').uncheck();
	await page.getByTestId('manage-topic-document').uncheck();
	await page.getByTestId('manage-save').click();
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row, 'an empty save must not delete the row').toBeTruthy();

	await page.goto(manageUrl);
	// A GET on the manage page must not unsubscribe either.
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row, 'a GET must not unsubscribe').toBeTruthy();

	await page.getByTestId('manage-unsubscribe').click();
	await expect(page.getByTestId('manage-gone')).toBeVisible();
	const remaining = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(remaining).toHaveLength(0);
});

// The outcome-parity property, probed with a malformed body rather than the
// happy path. Task 6's review found a live enumeration oracle here: duplicate
// topic values passed validation, hit `subscription_topic`'s composite primary
// key, and 500'd — but ONLY on the created/resent paths, because the `already`
// branch returns before touching topics. A confirmed subscriber therefore
// answered 200 where every other address answered 500. The schema now dedupes;
// this is the test that would have caught it, and the one that stops it coming
// back.
test('a malformed topic set cannot distinguish one address from another', async ({
	request,
	baseURL
}) => {
	// Posted directly rather than through the form: a browser cannot produce a
	// duplicate checkbox value. SvelteKit's CSRF protection is origin-header
	// based and an APIRequestContext sends none, so it is set explicitly.
	const post = (email: string) =>
		request.post('/de/subscribe', {
			headers: { origin: baseURL!, 'content-type': 'application/x-www-form-urlencoded' },
			data: `email=${encodeURIComponent(email)}&topics=document&topics=document`
		});

	const response = await post(`e2e-dup-${Date.now()}@example.test`);
	// A crafted body must not crash the route. Before the fix this raised 23505
	// on the composite primary key and surfaced as a 500 — which is precisely
	// what made the confirmed case, which never reaches that insert, distinguishable.
	expect(response.status(), 'a duplicate topic value must not 500').toBeLessThan(500);
});

// P4.4 and P4.16 together: the confirmed case must look identical to the other
// two, and the mail it sends must carry a link that actually authenticates —
// which is exactly what a future move back to hashed token storage would
// break, and break silently, since the mail would still be queued and still
// contain a URL.
test('re-subscribing a confirmed address changes nothing and mails a working manage link', async ({
	page
}) => {
	const email = `e2e-again-${Date.now()}@example.test`;

	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-advisory').check();
	await page.getByTestId('subscribe-submit').click();
	// use:enhance submits by fetch, not navigation, so click() resolves before
	// the mail is queued unless something waits for the re-render it causes —
	// without this, the DB read below races the submission.
	await expect(page.getByTestId('subscribe-submitted')).toBeVisible();
	await page.goto(await lastMailUrl(email, 'subscription_confirm'));
	await page.getByTestId('confirm-submit').click();
	await expect(page.getByTestId('confirm-done')).toBeVisible();

	// Submit again, with different topics. The browser must not be able to tell
	// this case from the first, and the topics must not move.
	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-document').check();
	await page.getByTestId('subscribe-submit').click();
	await expect(page.getByTestId('subscribe-submitted')).toBeVisible();

	await page.goto(await lastMailUrl(email, 'subscription_already'));
	await expect(page.getByTestId('manage-topic-advisory')).toBeChecked();
	await expect(page.getByTestId('manage-topic-document')).not.toBeChecked();

	const [row] = await db.select().from(subscription).where(eq(subscription.email, email));
	await db.delete(subscription).where(eq(subscription.id, row!.id));
});
