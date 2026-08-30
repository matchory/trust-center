import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin, signInAsApprover } from '../helpers/admin';

test('an admin reads the audit log and narrows it by action', async ({ page }) => {
	// Signing in is itself an audited event, so the log is never empty here and
	// the action asserted on below is one this test just caused.
	await signInAsAdmin(page);

	await gotoAdmin(page, '/de/admin/audit');
	await expect(page.getByRole('heading', { name: 'Audit-Log' })).toBeVisible();
	const unfiltered = await page.getByTestId(/^audit-[0-9a-f-]{36}$/).count();
	expect(unfiltered).toBeGreaterThan(0);

	await page.getByTestId('audit-filter-action').fill('staff.login.succeeded');
	await page.getByTestId('audit-filter-apply').click();

	// The filter is in the URL, which is what makes a filtered view shareable.
	await expect(page).toHaveURL(/[?&]action=staff\.login\.succeeded/);

	const actions = page.getByTestId(/^audit-action-/);
	await expect(actions.first()).toBeVisible();
	for (const text of await actions.allTextContents()) {
		expect(text).toBe('staff.login.succeeded');
	}

	// A filter matching nothing empties the table rather than erroring.
	await gotoAdmin(page, '/de/admin/audit?action=nothing.matches.this');
	await expect(page.getByTestId(/^audit-action-/)).toHaveCount(0);
	await expect(page.getByText('Keine Einträge vorhanden.')).toBeVisible();
});

test('an approver is refused the audit log and is not offered it in the nav', async ({ page }) => {
	await signInAsApprover(page);

	// The nav hides what the route refuses — the approver sees the triage
	// queue it is there for, and no audit link at all.
	await expect(page.getByTestId('admin-nav-requests')).toBeVisible();
	await expect(page.getByTestId('admin-nav-audit')).toHaveCount(0);

	const response = await gotoAdmin(page, '/de/admin/audit');
	expect(response?.status()).toBe(403);
	await expect(page.getByText(/restricted to administrators/i)).toBeVisible();
});
