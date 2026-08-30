import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { recordEvent } from '../../src/lib/server/audit';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent, requester } from '../../src/lib/server/db/schema';
import { upsertRequester } from '../../src/lib/server/identity/requester';
import { signInAsAdmin } from '../helpers/admin';

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
	await closeDb();
});

test('an operator purges a requester and the record shows it', async ({ page }) => {
	const email = `purge-${randomUUID()}@erasure.example`;
	const person = await upsertRequester(db, {
		email,
		name: 'E2E Person',
		company: 'Acme',
		locale: 'de'
	});

	await recordEvent(db, {
		action: 'document.downloaded',
		actor: { type: 'requester', id: person.id },
		subjectType: 'document_file',
		subjectId: randomUUID(),
		ip: '203.0.113.5',
		ua: 'Mozilla/5.0'
	});

	await signInAsAdmin(page);
	await page.goto('/de/admin/requesters');
	await expect(page.getByTestId(`requester-state-${person.id}`)).toHaveText('Aktiv');

	await page.goto(`/de/admin/requesters/${person.id}`);
	// The confirm() the button is guarded by; Playwright dismisses dialogs by
	// default, which would cancel the purge.
	page.on('dialog', (dialog) => dialog.accept());
	await page.getByTestId('requester-purge').click();

	await expect(page.getByTestId('requester-detail-state')).toHaveText('Gelöscht');
	// The action is gone with it: a purge is irreversible and not repeatable.
	await expect(page.getByTestId('requester-purge')).toHaveCount(0);

	const [after] = await db.select().from(requester).where(eq(requester.id, person.id));
	expect(after!.purgedAt).not.toBeNull();
	expect(after!.email).not.toContain('erasure.example');

	// The occurrence survives, pseudonymized; only the link to the person goes.
	expect(await db.select().from(auditEvent).where(eq(auditEvent.actorId, person.id))).toHaveLength(
		0
	);
	const purgeEvents = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, person.id));
	expect(purgeEvents.map((row) => row.action)).toContain('requester.purged');
});
