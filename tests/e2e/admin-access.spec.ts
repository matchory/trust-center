import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq, like } from 'drizzle-orm';
import { createGrant, GRANT_DEFAULT_DAYS_SETTING_KEY } from '../../src/lib/server/access/grants';
import { ruleTiers } from '../../src/lib/server/access/scope';
import { createDb, type Db } from '../../src/lib/server/db';
import { accessGrant, accessRule, requester, setting } from '../../src/lib/server/db/schema';
import { gotoAdmin, signInAsAdmin } from '../helpers/admin';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is not set — see package.json's test:e2e script.");
}

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await db.delete(accessRule).where(like(accessRule.pattern, '%.e2e-rule.example'));
	// The grant-duration setting is global: leaving it behind would silently
	// shorten the default term for every other spec sharing this database.
	await db.delete(setting).where(eq(setting.key, GRANT_DEFAULT_DAYS_SETTING_KEY));
	await closeDb();
});

/** A live grant held by a requester nobody else's fixture will collide with. */
async function seedGrant(): Promise<{ grantId: string; email: string }> {
	const email = `grant-${randomUUID()}@grants.example`;

	const [person] = await db
		.insert(requester)
		.values({
			email,
			name: 'E2E Grantee',
			company: 'Acme',
			companyDomain: 'grants.example',
			locale: 'de'
		})
		.returning({ id: requester.id });

	const { grantId } = await createGrant(db, {
		requesterId: person!.id,
		requestId: null,
		documentIds: [],
		tiers: ['request'],
		groupIds: [],
		termDays: 30,
		expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
	});

	return { grantId, email };
}

test('a new rule appears in the list and is stored as written', async ({ page }) => {
	const pattern = `${randomUUID().slice(0, 8)}.e2e-rule.example`;

	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/rules/new');

	await page.getByTestId('rule-pattern').fill(pattern);
	await page.getByTestId('rule-action').selectOption('auto_approve');
	await page.getByTestId('rule-tier-request').check();
	await page.getByTestId('rule-tier-nda').check();
	await page.getByTestId('rule-priority').fill('10');
	await page.getByTestId('rule-note').fill('E2E');
	await page.getByTestId('rule-create').click();

	await expect(page).toHaveURL(/\/de\/admin\/rules$/);
	await expect(page.getByText(pattern)).toBeVisible();

	const [row] = await db.select().from(accessRule).where(eq(accessRule.pattern, pattern));
	// `nda` is storable and not yet granted, so an operator naming it must find
	// it still named when they come back — the set is what was written, and
	// `max_tier` is the bridge until it is dropped.
	expect(row).toMatchObject({ action: 'auto_approve', maxTier: 'nda', priority: 10 });
	expect(await ruleTiers(db, row!.id)).toEqual(['nda', 'request']);
});

test('a pattern that could never match is refused at entry', async ({ page }) => {
	// Rejected here rather than discovered at decision time, when a stranger is
	// being handed documents.
	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/rules/new');

	await page.getByTestId('rule-pattern').fill('*.example');
	await page.getByTestId('rule-create').click();

	await expect(page.getByTestId('error-pattern')).toBeVisible();
	expect(
		await db.select().from(accessRule).where(eq(accessRule.pattern, '*.example'))
	).toHaveLength(0);
});

test('revoking a grant shows it as revoked and stamps the row', async ({ page }) => {
	const { grantId } = await seedGrant();

	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/grants');
	await expect(page.getByTestId(`grant-state-${grantId}`)).toHaveText('Aktiv');

	await page.getByTestId(`grant-revoke-${grantId}`).click();
	await expect(page.getByTestId(`grant-state-${grantId}`)).toHaveText('Entzogen');

	const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId));
	expect(row!.revokedAt).not.toBeNull();
	expect(row!.revokedByStaffId).not.toBeNull();
});

test('the grant duration setting overrides the environment default', async ({ page }) => {
	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/settings/access');

	await page.getByTestId('access-grant-default-days').fill('14');
	await page.getByTestId('access-save').click();
	await expect(page.getByTestId('access-saved')).toBeVisible();

	// Reloaded from the setting, not from ACCESS_GRANT_DEFAULT_DAYS.
	await page.reload();
	await expect(page.getByTestId('access-grant-default-days')).toHaveValue('14');
});
