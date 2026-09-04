import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin, signInAsApprover, submitAndWait } from '../helpers/admin';

test('an admin creates, edits and deletes an endpoint', async ({ page }) => {
	await signInAsAdmin(page);

	const host = `hooks-${randomUUID().slice(0, 8)}.example.test`;
	await gotoAdmin(page, '/de/admin/settings/integrations');
	await expect(page.getByRole('heading', { name: 'Integrationen' })).toBeVisible();

	await page.getByTestId('endpoint-name').fill('Ops Teams channel');
	await page.getByTestId('endpoint-url').fill(`https://${host}/webhook/abc?secret=shh`);
	await page.getByTestId('endpoint-format').selectOption('teams');
	await page.getByTestId('endpoint-patterns').fill('access_request.pending\naccess_grant.revoked');
	await submitAndWait(page, 'endpoint-create', '?/create');

	// The list shows the host and never the path, because a Teams Workflows URL
	// carries its shared secret in the query string (spec §11).
	const row = page.locator('[data-testid^="endpoint-row-"]').filter({ hasText: host });
	await expect(row).toHaveCount(1);
	await expect(row.getByTestId('endpoint-host')).toHaveText(host);
	await expect(page.locator('body')).not.toContainText('secret=shh');

	await row.getByRole('link').click();
	await expect(page).toHaveURL(/\/admin\/settings\/integrations\/[0-9a-f-]{36}$/);

	// The edit page is the one place the full URL appears — it is the form that
	// edits it.
	await expect(page.getByTestId('endpoint-url')).toHaveValue(/secret=shh/);

	await page.getByTestId('endpoint-name').fill('Renamed channel');
	await page.getByTestId('endpoint-patterns').fill('document.downloaded');
	await submitAndWait(page, 'endpoint-save', '?/save');
	await expect(page.getByTestId('endpoint-saved')).toBeVisible();

	// Revealing the derived secret is an action, not part of the page load: a
	// live HMAC secret must not sit in every SSR payload of this page, where it
	// would be in the HTML of every back-navigation and every browser cache.
	await expect(page.getByTestId('endpoint-secret')).toHaveCount(0);
	await submitAndWait(page, 'endpoint-reveal', '?/reveal');
	await expect(page.getByTestId('endpoint-secret')).toHaveText(/^[0-9a-f]{64}$/);

	// A URL the destination rules refuse is an operator typo, not a 500.
	await page.getByTestId('endpoint-url').fill('https://user:pass@example.test/hook');
	await submitAndWait(page, 'endpoint-save', '?/save');
	await expect(page.getByTestId('endpoint-error')).toBeVisible();

	await submitAndWait(page, 'endpoint-delete', '?/delete');
	await expect(page).toHaveURL(/\/admin\/settings\/integrations$/);
	await expect(
		page.locator('[data-testid^="endpoint-row-"]').filter({ hasText: host })
	).toHaveCount(0);
});

test('an approver is refused and never offered the link', async ({ page }) => {
	await signInAsApprover(page);

	// The nav hides what the route refuses — an approver must never be offered a
	// link that 403s.
	await expect(page.getByTestId('admin-nav-requests')).toBeVisible();
	await expect(page.getByTestId('admin-nav-integrations')).toHaveCount(0);

	const response = await gotoAdmin(page, '/de/admin/settings/integrations');
	expect(response?.status()).toBe(403);
	await expect(page.getByText(/restricted to administrators/i)).toBeVisible();
});

test('the audit sink panel reports a deployment with no sink honestly', async ({ page }) => {
	await signInAsAdmin(page);
	await gotoAdmin(page, '/de/admin/settings/integrations');

	const panel = page.getByTestId('auditsink-panel');
	await expect(panel).toBeVisible();

	// The e2e deployment sets no AUDIT_SINK_* variables, so both facts must be
	// on the page: the sink is off, and nothing is configured to ship to. A
	// panel that rendered empty here would look like a healthy sink.
	await expect(page.getByTestId('auditsink-off')).toBeVisible();
	await expect(panel.getByTestId('auditsink-row-s3')).toBeVisible();
	await expect(panel.getByTestId('auditsink-row-syslog')).toBeVisible();
	await expect(panel.getByTestId('auditsink-unconfigured').first()).toBeVisible();

	// Coverage is a comparison of the log's own height against what the batches
	// recorded, and this deployment has cut none (spec §10).
	await expect(panel.getByTestId('auditsink-coverage')).toContainText('Es wurde noch kein Stapel');
	await expect(panel.getByTestId('auditsink-attested')).toContainText('Nie attestiert');

	// No backlog badge: nothing is pending because nothing is configured.
	await expect(page.getByTestId('admin-nav-auditsink-backlog')).toHaveCount(0);

	// Read-only (spec §10): the panel adds no form and no button.
	await expect(panel.locator('form')).toHaveCount(0);
	await expect(panel.locator('button')).toHaveCount(0);
});
