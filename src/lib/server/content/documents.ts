import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DocumentStatus, DocumentTier } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import { groupByKey } from '../collections';
import type { Db } from '../db';
import {
	document,
	documentCategory,
	documentCategoryTranslation,
	documentFile,
	documentTranslation
} from '../db/schema';

export type { DocumentStatus, DocumentTier } from '../../content-types';

export interface PublicDocumentFile {
	id: string;
	locale: string;
	version: number;
	filename: string;
	sizeBytes: number;
	sha256: string;
	validFrom: Date | null;
	validUntil: Date | null;
}

export interface PublicDocument {
	id: string;
	slug: string;
	tier: DocumentTier;
	title: string;
	summary: string | null;
	/** The locale the title and summary were actually taken from. */
	translationLocale: string;
	isTranslationFallback: boolean;
	/** Always `null` for a gated tier — see `listDocumentsByTier`. */
	file: PublicDocumentFile | null;
	isFileFallback: boolean;
}

export interface PublicDocumentCategory {
	id: string;
	slug: string;
	name: string;
	/** The locale the name was actually taken from — the portal labels fallbacks. */
	nameLocale: string;
	isNameFallback: boolean;
	documents: PublicDocument[];
}

/**
 * The portal read model, filtered to published documents in the given tiers in
 * the query rather than in the caller — the guarantee a gated document's file
 * never reaches public HTML, JSON, or the sitemap (spec §12) is only as good as
 * the narrowest place it is enforced.
 *
 * Files are fetched for public-tier documents only, so a gated document's file
 * id never leaves the database. A gated row therefore carries its title and
 * tier — enough for the portal to offer the request affordance — and nothing
 * that could be turned into a download URL.
 *
 * An entity with no translation in the requested locale and none in the
 * default locale is omitted rather than rendered untitled.
 */
async function listDocumentsByTier(
	db: Db,
	tiers: readonly DocumentTier[],
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocumentCategory[]> {
	const rows = await db
		.select({
			categoryId: documentCategory.id,
			categorySlug: documentCategory.slug,
			documentId: document.id,
			documentSlug: document.slug,
			documentTier: document.tier
		})
		.from(document)
		.innerJoin(documentCategory, eq(document.categoryId, documentCategory.id))
		.where(and(eq(document.status, 'published'), inArray(document.tier, [...tiers])))
		.orderBy(
			asc(documentCategory.position),
			asc(documentCategory.slug),
			asc(document.position),
			asc(document.slug)
		);

	if (rows.length === 0) return [];

	const documentIds = rows.map((row) => row.documentId);
	const fileDocumentIds = rows
		.filter((row) => row.documentTier === 'public')
		.map((row) => row.documentId);
	const categoryIds = [...new Set(rows.map((row) => row.categoryId))];

	const [categoryNames, titles, files] = await Promise.all([
		db
			.select()
			.from(documentCategoryTranslation)
			.where(inArray(documentCategoryTranslation.categoryId, categoryIds)),
		db
			.select()
			.from(documentTranslation)
			.where(inArray(documentTranslation.documentId, documentIds)),
		fileDocumentIds.length === 0
			? []
			: db
					.select()
					.from(documentFile)
					.where(
						and(inArray(documentFile.documentId, fileDocumentIds), eq(documentFile.isCurrent, true))
					)
	]);

	const namesByCategory = groupByKey(categoryNames, (row) => row.categoryId);
	const titlesByDocument = groupByKey(titles, (row) => row.documentId);
	const filesByDocument = groupByKey(files, (row) => row.documentId);

	const result: PublicDocumentCategory[] = [];

	for (const categoryId of categoryIds) {
		const pickedName = pickTranslation(
			(namesByCategory.get(categoryId) ?? []).map((row) => ({
				locale: row.locale,
				value: row.name
			})),
			opts.locale,
			opts.defaultLocale
		);
		if (!pickedName) continue;

		const documents: PublicDocument[] = [];

		for (const row of rows.filter((candidate) => candidate.categoryId === categoryId)) {
			const pickedTitle = pickTranslation(
				(titlesByDocument.get(row.documentId) ?? []).map((translation) => ({
					locale: translation.locale,
					value: translation
				})),
				opts.locale,
				opts.defaultLocale
			);
			if (!pickedTitle) continue;

			const pickedFile = pickTranslation(
				(filesByDocument.get(row.documentId) ?? []).map((file) => ({
					locale: file.locale,
					value: file
				})),
				opts.locale,
				opts.defaultLocale
			);

			documents.push({
				id: row.documentId,
				slug: row.documentSlug,
				tier: row.documentTier as DocumentTier,
				title: pickedTitle.value.title,
				summary: pickedTitle.value.summary,
				translationLocale: pickedTitle.locale,
				isTranslationFallback: pickedTitle.isFallback,
				file: pickedFile
					? {
							id: pickedFile.value.id,
							locale: pickedFile.value.locale,
							version: pickedFile.value.version,
							filename: pickedFile.value.filename,
							sizeBytes: pickedFile.value.sizeBytes,
							sha256: pickedFile.value.sha256,
							validFrom: pickedFile.value.validFrom,
							validUntil: pickedFile.value.validUntil
						}
					: null,
				isFileFallback: pickedFile?.isFallback ?? false
			});
		}

		if (documents.length === 0) continue;

		const category = rows.find((row) => row.categoryId === categoryId);
		result.push({
			id: categoryId,
			slug: category?.categorySlug ?? '',
			name: pickedName.value,
			nameLocale: pickedName.locale,
			isNameFallback: pickedName.isFallback,
			documents
		});
	}

	return result;
}

/** Published, public-tier documents. The sitemap and every public surface use this. */
export function listPublicDocuments(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocumentCategory[]> {
	return listDocumentsByTier(db, ['public'], opts);
}

/**
 * Every published document the documents page shows, gated ones included, so a
 * visitor can see that a report exists and ask for it. Gated rows carry a tier
 * and no file.
 */
export function listPortalDocuments(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocumentCategory[]> {
	return listDocumentsByTier(db, ['public', 'request', 'nda'], opts);
}

/** One published, public-tier document by slug, or null. */
export async function getPublicDocument(
	db: Db,
	slug: string,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocument | null> {
	const categories = await listPublicDocuments(db, opts);
	return (
		categories.flatMap((category) => category.documents).find((doc) => doc.slug === slug) ?? null
	);
}

export interface AdminDocumentRow {
	id: string;
	slug: string;
	categoryId: string;
	tier: DocumentTier;
	status: DocumentStatus;
	position: number;
	titles: Record<string, string>;
	updatedAt: Date;
}

export interface AdminDocumentFile {
	id: string;
	locale: string;
	version: number;
	filename: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	storageKey: string;
	validFrom: Date | null;
	validUntil: Date | null;
	isCurrent: boolean;
	createdAt: Date;
}

export interface AdminDocument extends AdminDocumentRow {
	translations: { locale: string; title: string; summary: string | null }[];
	files: AdminDocumentFile[];
}

export async function listDocumentsForAdmin(db: Db): Promise<AdminDocumentRow[]> {
	const rows = await db.select().from(document).orderBy(asc(document.position), asc(document.slug));
	if (rows.length === 0) return [];

	const titles = await db
		.select()
		.from(documentTranslation)
		.where(
			inArray(
				documentTranslation.documentId,
				rows.map((row) => row.id)
			)
		);
	const byDocument = groupByKey(titles, (row) => row.documentId);

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		categoryId: row.categoryId,
		tier: row.tier as DocumentTier,
		status: row.status as DocumentStatus,
		position: row.position,
		updatedAt: row.updatedAt,
		titles: Object.fromEntries(
			(byDocument.get(row.id) ?? []).map((translation) => [translation.locale, translation.title])
		)
	}));
}

export async function getDocumentForAdmin(db: Db, id: string): Promise<AdminDocument | null> {
	const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1);
	if (!row) return null;

	const [translations, files] = await Promise.all([
		db.select().from(documentTranslation).where(eq(documentTranslation.documentId, id)),
		db
			.select()
			.from(documentFile)
			.where(eq(documentFile.documentId, id))
			.orderBy(asc(documentFile.locale), asc(documentFile.version))
	]);

	return {
		id: row.id,
		slug: row.slug,
		categoryId: row.categoryId,
		tier: row.tier as DocumentTier,
		status: row.status as DocumentStatus,
		position: row.position,
		updatedAt: row.updatedAt,
		titles: Object.fromEntries(translations.map((t) => [t.locale, t.title])),
		translations: translations.map((t) => ({
			locale: t.locale,
			title: t.title,
			summary: t.summary
		})),
		files
	};
}

export async function createDocument(
	db: Db,
	input: { slug: string; categoryId: string; tier?: DocumentTier; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(document)
		.values({
			slug: input.slug,
			categoryId: input.categoryId,
			tier: input.tier ?? 'public',
			position: input.position ?? 0
		})
		.returning({ id: document.id });

	if (!row) throw new Error('failed to insert document');
	return row.id;
}

export async function updateDocument(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		categoryId: string;
		tier: DocumentTier;
		status: DocumentStatus;
		position: number;
	}>
): Promise<void> {
	await db
		.update(document)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(document.id, id));
}

export async function deleteDocument(db: Db, id: string): Promise<string[]> {
	// Returns the storage keys of the files that went with it, so the caller
	// can clean up the objects the cascade cannot reach.
	const files = await db
		.select({ storageKey: documentFile.storageKey })
		.from(documentFile)
		.where(eq(documentFile.documentId, id));

	await db.delete(document).where(eq(document.id, id));
	return files.map((file) => file.storageKey);
}

export async function setDocumentTranslation(
	db: Db,
	documentId: string,
	locale: string,
	values: { title: string; summary: string | null }
): Promise<void> {
	await db
		.insert(documentTranslation)
		.values({ documentId, locale, ...values })
		.onConflictDoUpdate({
			target: [documentTranslation.documentId, documentTranslation.locale],
			set: values
		});
}

export async function deleteDocumentTranslation(
	db: Db,
	documentId: string,
	locale: string
): Promise<void> {
	await db
		.delete(documentTranslation)
		.where(
			and(eq(documentTranslation.documentId, documentId), eq(documentTranslation.locale, locale))
		);
}

export interface NewDocumentFile {
	documentId: string;
	locale: string;
	storageKey: string;
	sha256: string;
	sizeBytes: number;
	filename: string;
	contentType: string;
	validFrom: Date | null;
	validUntil: Date | null;
	uploadedByStaffId: string | null;
}

/**
 * Adds the next version for a (document, locale) and makes it current.
 *
 * The order inside the transaction matters: the previous current row is
 * cleared *before* the new one is inserted, because the partial unique index
 * permits only one current file per (document, locale) at any instant. Two
 * concurrent uploads for the same pair race on the version unique index and
 * the loser is rejected — the right outcome for an operation a human performs.
 */
export async function addDocumentFile(db: Db, input: NewDocumentFile): Promise<string> {
	return db.transaction(async (tx) => {
		const [highest] = await tx
			.select({ version: sql<number>`coalesce(max(${documentFile.version}), 0)` })
			.from(documentFile)
			.where(
				and(eq(documentFile.documentId, input.documentId), eq(documentFile.locale, input.locale))
			);

		await tx
			.update(documentFile)
			.set({ isCurrent: false })
			.where(
				and(
					eq(documentFile.documentId, input.documentId),
					eq(documentFile.locale, input.locale),
					eq(documentFile.isCurrent, true)
				)
			);

		const [row] = await tx
			.insert(documentFile)
			.values({ ...input, version: Number(highest?.version ?? 0) + 1, isCurrent: true })
			.returning({ id: documentFile.id });

		if (!row) throw new Error('failed to insert document file');
		return row.id;
	});
}

/** Removes a file row and returns its storage key so the object can be deleted. */
export async function deleteDocumentFile(db: Db, fileId: string): Promise<string | null> {
	const [row] = await db
		.delete(documentFile)
		.where(eq(documentFile.id, fileId))
		.returning({ storageKey: documentFile.storageKey });

	return row?.storageKey ?? null;
}

export interface AdminCategory {
	id: string;
	slug: string;
	position: number;
	names: Record<string, string>;
}

export async function listCategories(db: Db): Promise<AdminCategory[]> {
	const rows = await db
		.select()
		.from(documentCategory)
		.orderBy(asc(documentCategory.position), asc(documentCategory.slug));
	if (rows.length === 0) return [];

	const names = await db.select().from(documentCategoryTranslation);
	const byCategory = groupByKey(names, (row) => row.categoryId);

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries((byCategory.get(row.id) ?? []).map((n) => [n.locale, n.name]))
	}));
}

export async function createCategory(
	db: Db,
	input: { slug: string; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(documentCategory)
		.values({ slug: input.slug, position: input.position ?? 0 })
		.returning({ id: documentCategory.id });

	if (!row) throw new Error('failed to insert document category');
	return row.id;
}

export async function updateCategory(
	db: Db,
	id: string,
	input: Partial<{ slug: string; position: number }>
): Promise<void> {
	await db.update(documentCategory).set(input).where(eq(documentCategory.id, id));
}

export async function setCategoryTranslation(
	db: Db,
	categoryId: string,
	locale: string,
	values: { name: string }
): Promise<void> {
	await db
		.insert(documentCategoryTranslation)
		.values({ categoryId, locale, ...values })
		.onConflictDoUpdate({
			target: [documentCategoryTranslation.categoryId, documentCategoryTranslation.locale],
			set: values
		});
}

export async function deleteCategory(db: Db, id: string): Promise<void> {
	await db.delete(documentCategory).where(eq(documentCategory.id, id));
}
