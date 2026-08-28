import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { documentCategory, document as documentTable } from '../../src/lib/server/db/schema';
import {
	addDocumentFile,
	createCategory,
	createDocument,
	getDocumentForAdmin,
	listPublicDocuments,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Content tables, unlike audit_event, are ordinary state and may be cleared
	// between tests. Deleting the category cascades to its documents.
	await db.delete(documentTable);
	await db.delete(documentCategory);
});

async function seedPublishedDocument(overrides: { tier?: 'public' | 'request' } = {}) {
	const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
	await setCategoryTranslation(db, categoryId, 'en', { name: 'Legal' });

	const documentId = await createDocument(db, {
		slug: 'avv',
		categoryId,
		tier: overrides.tier ?? 'public',
		position: 0
	});
	await setDocumentTranslation(db, documentId, 'de', {
		title: 'Auftragsverarbeitungsvertrag',
		summary: 'AVV nach Art. 28 DSGVO'
	});
	await updateDocument(db, documentId, { status: 'published' });

	return { categoryId, documentId };
}

describe('document repository', () => {
	it('lists a published public document under its category', async () => {
		await seedPublishedDocument();

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories).toHaveLength(1);
		expect(categories[0]?.name).toBe('Rechtliches');
		expect(categories[0]?.documents[0]?.title).toBe('Auftragsverarbeitungsvertrag');
		expect(categories[0]?.documents[0]?.isTranslationFallback).toBe(false);
	});

	it('hides a draft document from the portal', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
		const documentId = await createDocument(db, { slug: 'draft', categoryId, position: 0 });
		await setDocumentTranslation(db, documentId, 'de', { title: 'Entwurf', summary: null });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('hides a published document whose tier is not public', async () => {
		// The gate itself is Phase 2. The filter is here from the start so the
		// security regression test in Task 6 can be permanent rather than
		// waiting for the machinery it guards.
		await seedPublishedDocument({ tier: 'request' });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('falls back to the default locale and says so', async () => {
		await seedPublishedDocument();

		const categories = await listPublicDocuments(db, { locale: 'en', defaultLocale: 'de' });
		const doc = categories[0]?.documents[0];

		expect(doc?.title).toBe('Auftragsverarbeitungsvertrag');
		expect(doc?.isTranslationFallback).toBe(true);
		expect(doc?.translationLocale).toBe('de');
	});

	it('omits an entity with no translation in any served locale', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
		const documentId = await createDocument(db, { slug: 'untitled', categoryId, position: 0 });
		await updateDocument(db, documentId, { status: 'published' });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('attaches the current file for the requested locale', async () => {
		const { documentId } = await seedPublishedDocument();
		await addDocumentFile(db, {
			documentId,
			locale: 'de',
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			sha256: 'a'.repeat(64),
			sizeBytes: 1024,
			filename: 'avv-de.pdf',
			contentType: 'application/pdf',
			validFrom: new Date('2026-01-01T00:00:00Z'),
			validUntil: new Date('2027-01-01T00:00:00Z'),
			uploadedByStaffId: null
		});

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });
		const doc = categories[0]?.documents[0];

		expect(doc?.file?.filename).toBe('avv-de.pdf');
		expect(doc?.file?.version).toBe(1);
		expect(doc?.isFileFallback).toBe(false);
	});

	it('falls back to the default locale file and says so', async () => {
		const { documentId } = await seedPublishedDocument();
		await addDocumentFile(db, {
			documentId,
			locale: 'de',
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			sha256: 'a'.repeat(64),
			sizeBytes: 1024,
			filename: 'avv-de.pdf',
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		});

		const categories = await listPublicDocuments(db, { locale: 'en', defaultLocale: 'de' });

		expect(categories[0]?.documents[0]?.isFileFallback).toBe(true);
	});

	it('supersedes the previous version, leaving exactly one current file per locale', async () => {
		const { documentId } = await seedPublishedDocument();
		const common = {
			documentId,
			locale: 'de' as const,
			sha256: 'a'.repeat(64),
			sizeBytes: 10,
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		};

		await addDocumentFile(db, {
			...common,
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			filename: 'v1.pdf'
		});
		await addDocumentFile(db, {
			...common,
			storageKey: 'ab/cd/22222222-2222-4222-8222-222222222222',
			filename: 'v2.pdf'
		});

		const admin = await getDocumentForAdmin(db, documentId);
		const current = admin?.files.filter((file) => file.isCurrent) ?? [];

		expect(current).toHaveLength(1);
		expect(current[0]?.filename).toBe('v2.pdf');
		expect(current[0]?.version).toBe(2);
		// Superseded versions are retained: spec section 9 records which file
		// version was actually retrieved, so the row must outlive the upload.
		expect(admin?.files).toHaveLength(2);
	});

	it('rejects a duplicate slug', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await createDocument(db, { slug: 'avv', categoryId, position: 0 });

		await expect(createDocument(db, { slug: 'avv', categoryId, position: 1 })).rejects.toThrow();
	});
});
