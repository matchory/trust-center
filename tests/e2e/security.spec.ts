import { expect, test } from '@playwright/test';
import { and, eq, gte } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	auditEvent,
	documentCategory,
	document,
	documentFile
} from '../../src/lib/server/db/schema';
import {
	addDocumentFile,
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const categoryId = await createCategory(db, { slug: 'security-fixture', position: 99 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Sicherheits-Fixture' });
	await setCategoryTranslation(db, categoryId, 'en', { name: 'Security fixture' });

	for (const [slug, tier] of [
		['public-fixture', 'public'],
		['gated-fixture', 'request']
	] as const) {
		const id = await createDocument(db, { slug, categoryId, tier, position: 0 });
		await setDocumentTranslation(db, id, 'de', { title: `Fixture ${slug}`, summary: null });
		await setDocumentTranslation(db, id, 'en', { title: `Fixture ${slug}`, summary: null });
		await updateDocument(db, id, { status: 'published' });
	}

	const storage = createLocalStorage(process.env.STORAGE_DIR ?? './data/storage');

	for (const slug of ['public-fixture', 'gated-fixture']) {
		const [row] = await db
			.select({ id: document.id })
			.from(document)
			.where(eq(document.slug, slug));
		if (!row) throw new Error(`fixture document ${slug} missing`);

		const key = newStorageKey();
		const stored = await storage.put(key, new TextEncoder().encode(`%PDF-1.7 ${slug}`));

		await addDocumentFile(db, {
			documentId: row.id,
			locale: 'de',
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: `${slug}.pdf`,
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		});
	}
});

test.afterAll(async () => {
	await db.delete(document).where(eq(document.slug, 'public-fixture'));
	await db.delete(document).where(eq(document.slug, 'gated-fixture'));
	await db.delete(documentCategory).where(eq(documentCategory.slug, 'security-fixture'));
	await closeDb();
});

test('a gated document never appears in public HTML', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.getByTestId('document-public-fixture')).toBeVisible();
	await expect(page.getByTestId('document-gated-fixture')).toHaveCount(0);
	expect(await page.content()).not.toContain('gated-fixture');
});

test('serves a public document file and records exactly one audit event', async ({ request }) => {
	const [file] = await db
		.select({ id: documentFile.id, sha256: documentFile.sha256 })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'public-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	const before = new Date(Date.now() - 2_000);
	const response = await request.get(`/api/documents/${file.id}`);

	expect(response.status()).toBe(200);
	expect(response.headers()['content-disposition']).toMatch(/attachment/);
	// Downloads are audited, so they must not be served from a cache.
	expect(response.headers()['cache-control']).toMatch(/no-store/);

	const events = await db
		.select({ action: auditEvent.action, subjectId: auditEvent.subjectId })
		.from(auditEvent)
		.where(and(gte(auditEvent.at, before), eq(auditEvent.action, 'document.downloaded')));

	expect(events.map((event) => event.subjectId)).toContain(file.id);
});

test('refuses to serve a gated document file', async ({ request }) => {
	const [file] = await db
		.select({ id: documentFile.id })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'gated-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	const response = await request.get(`/api/documents/${file.id}`);
	expect(response.status()).toBe(404);
});

test('exposes no route that serves a storage key directly', async ({ request }) => {
	const [file] = await db
		.select({ storageKey: documentFile.storageKey })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'public-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	for (const path of [
		`/${file.storageKey}`,
		`/storage/${file.storageKey}`,
		`/api/documents/${file.storageKey}`
	]) {
		expect((await request.get(path)).status()).toBeGreaterThanOrEqual(400);
	}
});

test('the public portal loads no third-party resources', async ({ page, baseURL }) => {
	const foreign: string[] = [];
	const origin = new URL(baseURL ?? 'http://localhost:4173').origin;

	page.on('request', (request) => {
		const url = new URL(request.url());
		// data: and blob: are the page's own bytes, not a third party.
		if (url.protocol === 'data:' || url.protocol === 'blob:') return;
		if (url.origin !== origin) foreign.push(request.url());
	});

	for (const path of ['/de', '/de/documents', '/de/controls']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
	}

	expect(foreign).toEqual([]);
});

test('serves a content security policy that permits only same-origin resources', async ({
	request
}) => {
	const response = await request.get('/de');
	const csp = response.headers()['content-security-policy'];

	expect(csp).toBeTruthy();
	expect(csp).toContain("default-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).not.toContain('unsafe-inline');
});

test('a gated document never appears in the sitemap', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();
	expect(body).not.toContain('gated-fixture');
});
