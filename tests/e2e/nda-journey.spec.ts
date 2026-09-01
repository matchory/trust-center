import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { addDocumentFile } from '../../src/lib/server/content/documents';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRequest,
	accessRequestDocument,
	documentFile,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	outboundEmail,
	requester
} from '../../src/lib/server/db/schema';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import { gotoAdmin, seedRequestForAgreement, signInAsAdmin, submitAndWait } from '../helpers/admin';
import { docxWith } from '../helpers/docx';
import { awaitHydration } from '../helpers/hydration';
import { blankPdf, drawnText } from '../helpers/pdf';

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

/** Gives the seeded document a real file, so the journey can end in a download. */
async function attachFile(documentId: string): Promise<number> {
	const storage = createLocalStorage(process.env.STORAGE_DIR ?? './data/storage');
	const stored = await storage.put(newStorageKey(), await blankPdf(2));

	for (const locale of ['de', 'en']) {
		await addDocumentFile(db, {
			documentId,
			locale,
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			contentType: 'application/pdf',
			filename: 'gated.pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		});
	}

	return stored.size;
}

test('an NDA-gated document is requested, approved, accepted and downloaded', async ({ page }) => {
	// The longest chain in the suite. Every admin interaction goes through
	// gotoAdmin and submitAndWait — an e2e step that interacts before hydration
	// does not fail, it lies, and the accept button is exactly where a lost
	// interaction would produce a passing test over a missing record.

	// 1. An operator publishes an agreement and files a document behind it; a
	//    prospect requests it and verifies by magic link. The requester session
	//    the seed leaves behind is scoped to /de/access, so it coexists with the
	//    admin one and both are usable below — access-journey.spec.ts already
	//    covers the sign-in link itself.
	await signInAsAdmin(page);
	const { requestId, documentId, documentSlug, agreementSlug, email } =
		await seedRequestForAgreement(page, db);
	const storedBytes = await attachFile(documentId);

	// 2. An approver approves, confirming the proposed agreement rather than
	//    waiving it.
	await gotoAdmin(page, `/de/admin/requests/${requestId}`);
	await expect(page.getByTestId('requirement-row')).toHaveCount(1);
	await expect(page.getByTestId('requirement-waive')).not.toBeChecked();
	await submitAndWait(page, 'decision-approve', '?/approve');

	// 3. The grant is inert: no clock, and a deadline to accept by.
	const [grant] = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
	expect(grant?.expiresAt).toBeNull();
	expect(grant?.acceptanceDueAt).not.toBeNull();

	// 4. The mail says a step remains, rather than "your access is ready".
	const approvalMail = (
		await db.select().from(outboundEmail).where(eq(outboundEmail.to, email))
	).map((row) => row.template);
	expect(approvalMail).toContain('request_acceptance_required');
	expect(approvalMail).not.toContain('request_approved');

	// 5. The portal says one step is left rather than showing an empty page.
	await page.goto('/de/access');
	await awaitHydration(page);
	await expect(page.getByTestId('grant-pending-acceptance')).toBeVisible();
	// An inert grant confers nothing, so the document is not listed at all.
	await expect(page.getByTestId(`access-document-${documentSlug}`)).toHaveCount(0);

	// 6. And the direct download 404s while the acceptance is outstanding — the
	//    absence of a link is not the control, the query is.
	const [file] = await db
		.select({ id: documentFile.id })
		.from(documentFile)
		.where(eq(documentFile.documentId, documentId));
	const downloadUrl = `/de/access/documents/${file!.id}`;
	expect((await page.request.get(downloadUrl)).status()).toBe(404);

	// 7. The requester reads the agreement, types their name, and accepts.
	await page.getByTestId('access-open-agreements').click();
	await awaitHydration(page);
	await page.getByTestId(`agreement-open-${agreementSlug}`).click();
	await awaitHydration(page);

	await expect(page.getByTestId('agreement-body')).toBeVisible();
	await page.getByTestId('agreement-typed-name').fill('Šimon Čech');
	await submitAndWait(page, 'agreement-accept', `/access/agreements/`);

	// 8. The record exists, pinned to what was shown, with its rendering stored.
	const [person] = await db.select().from(requester).where(eq(requester.email, email));
	const [acceptance] = await db
		.select()
		.from(ndaAcceptance)
		.where(eq(ndaAcceptance.requesterId, person!.id));
	expect(acceptance?.typedName).toBe('Šimon Čech');
	expect(acceptance?.templateSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(acceptance?.recordPdfKey).toMatch(/\S/);

	// 9. The record mail carries the storage key, not the bytes.
	const recordMail = (
		await db.select().from(outboundEmail).where(eq(outboundEmail.to, email))
	).filter((row) => row.template === 'nda_record');
	expect(recordMail).toHaveLength(1);
	expect(
		(recordMail[0]!.payload as { attachments?: { filename: string; storageKey: string }[] })
			.attachments?.[0]
	).toMatchObject({ filename: 'acceptance.pdf' });

	// 10. Activation started the clock — now, not at approval, so a week spent
	//     reading the agreement is not a week of access lost.
	const [activated] = await db.select().from(accessGrant).where(eq(accessGrant.id, grant!.id));
	expect(activated?.expiresAt).not.toBeNull();
	expect(activated?.acceptanceDueAt).toBeNull();

	// 11. The document downloads, watermarked with a name no standard PDF font
	//     could have encoded, and the record is fetchable from the portal too
	//     (§10.3) — not only from a mailbox the requester may no longer have.
	await page.goto('/de/access');
	await awaitHydration(page);
	await expect(page.getByTestId('grant-pending-acceptance')).toHaveCount(0);
	await expect(page.getByTestId(`access-document-${documentSlug}`)).toBeVisible();

	const download = await page.request.get(downloadUrl);
	expect(download.status()).toBe(200);

	const body = await download.body();
	expect(body.byteLength).toBeGreaterThan(storedBytes);
	// The watermark carries the identity on the requester row; the typed name is
	// a fact about the signature and lives on the record, asserted below.
	expect(await drawnText(body)).toContain(email);

	const recordHref = await page
		.getByTestId(`access-record-download-${agreementSlug}`)
		.getAttribute('href');
	if (!recordHref) throw new Error('no record link on the portal');

	const record = await page.request.get(recordHref);
	expect(record.status()).toBe(200);
	expect(record.headers()['content-type']).toContain('application/pdf');
	expect(await drawnText(await record.body())).toContain('Šimon Čech');
});

test('a second request by a requester holding a current acceptance activates at once', async ({
	page
}) => {
	// §9.9's fast path, which is the same activateGrants call made at approval
	// rather than a separate path — there is nothing else to exercise it.
	await signInAsAdmin(page);
	const first = await seedRequestForAgreement(page, db);

	await gotoAdmin(page, `/de/admin/requests/${first.requestId}`);
	await submitAndWait(page, 'decision-approve', '?/approve');

	await page.goto('/de/access');
	await awaitHydration(page);
	await page.getByTestId('access-open-agreements').click();
	await awaitHydration(page);
	await page.getByTestId(`agreement-open-${first.agreementSlug}`).click();
	await awaitHydration(page);
	await page.getByTestId('agreement-typed-name').fill('Šimon Čech');
	await submitAndWait(page, 'agreement-accept', `/access/agreements/`);

	// A second request from the same person, for the same agreement. Approving it
	// finds every requirement already satisfied, so the grant never goes inert.
	const [person] = await db.select().from(requester).where(eq(requester.email, first.email));
	const second = await seedSecondRequest(first.documentId, person!.id);

	await gotoAdmin(page, `/de/admin/requests/${second}`);
	await submitAndWait(page, 'decision-approve', '?/approve');

	const [grant] = await db.select().from(accessGrant).where(eq(accessGrant.requestId, second));
	expect(grant?.expiresAt).not.toBeNull();
	expect(grant?.acceptanceDueAt).toBeNull();
});

/**
 * A second verified, pending request from a requester who already exists —
 * written through the modules rather than the form, because the submission
 * limiter and the magic-link round trip are covered elsewhere and this case is
 * about what the *approval* does.
 */
async function seedSecondRequest(documentId: string, requesterId: string): Promise<string> {
	const [row] = await db
		.insert(accessRequest)
		.values({ requesterId, status: 'pending' })
		.returning({ id: accessRequest.id });

	await db.insert(accessRequestDocument).values({ requestId: row!.id, documentId });
	return row!.id;
}

test('refuses an import into a version somebody has already accepted', async ({ page }) => {
	// Here rather than in admin-agreements.spec.ts because a version becomes
	// immutable only once somebody has accepted it, and this file already drives
	// a full acceptance — rebuilding one to reach the guard would be a second
	// copy of the longest chain in the suite.
	await signInAsAdmin(page);
	const seeded = await seedRequestForAgreement(page, db);

	await gotoAdmin(page, `/de/admin/requests/${seeded.requestId}`);
	await submitAndWait(page, 'decision-approve', '?/approve');

	await page.goto('/de/access');
	await awaitHydration(page);
	await page.getByTestId('access-open-agreements').click();
	await awaitHydration(page);
	await page.getByTestId(`agreement-open-${seeded.agreementSlug}`).click();
	await awaitHydration(page);
	await page.getByTestId('agreement-typed-name').fill('Šimon Čech');
	await submitAndWait(page, 'agreement-accept', `/access/agreements/`);

	const [template] = await db
		.select()
		.from(ndaTemplate)
		.where(eq(ndaTemplate.slug, seeded.agreementSlug));
	const [version] = await db
		.select()
		.from(ndaTemplateVersion)
		.where(eq(ndaTemplateVersion.templateId, template!.id));

	// The immutability guard is the server's; the disabled control on the page is
	// only a courtesy, so this posts straight at the action. `page.request`
	// carries the staff cookie the sign-in above left in the context, and the
	// Origin header is what SvelteKit's CSRF check wants from a form POST.
	const response = await page.request.post(
		`/de/admin/agreements/${template!.id}/versions/${version!.id}?/import`,
		{
			headers: { origin: new URL(page.url()).origin },
			multipart: {
				locale: 'de',
				file: {
					name: 'nda.docx',
					mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					buffer: Buffer.from(docxWith([{ text: 'Neuer Text.' }]))
				}
			}
		}
	);

	// SvelteKit answers a scripted POST with an ActionResult envelope — HTTP 200
	// carrying the failure — so the refusal to assert is the one inside it, and
	// asserting the reason as well is what keeps this from passing on any 4xx.
	const result = (await response.json()) as { type: string; status: number; data: string };
	expect(result.type).toBe('failure');
	expect(result.status).toBe(409);
	expect(result.data).toContain('immutable');
});
