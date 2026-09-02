import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { UpdateKind } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import { updatePost, updatePostSubprocessor, updatePostTranslation } from '../db/schema';

export interface PublicUpdate {
	id: string;
	slug: string;
	kind: UpdateKind;
	publishedAt: Date;
	title: string;
	body: string;
	translationLocale: string;
	isTranslationFallback: boolean;
}

export async function listPublicUpdates(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicUpdate[]> {
	// One column answers both "is it published" and "is it scheduled": a null
	// date is a draft, a future date is scheduled, and neither is public yet.
	const rows = await db
		.select()
		.from(updatePost)
		.where(and(isNotNull(updatePost.publishedAt), lte(updatePost.publishedAt, new Date())))
		.orderBy(desc(updatePost.publishedAt));

	if (rows.length === 0) return [];

	const translations = await db
		.select()
		.from(updatePostTranslation)
		.where(
			inArray(
				updatePostTranslation.postId,
				rows.map((row) => row.id)
			)
		);

	const result: PublicUpdate[] = [];

	for (const row of rows) {
		if (!row.publishedAt) continue;
		const mine = translations.filter((item) => item.postId === row.id);

		const title = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.title })),
			opts.locale,
			opts.defaultLocale
		);
		if (!title) continue;

		const body = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.body })),
			opts.locale,
			opts.defaultLocale
		);
		if (!body) continue;

		result.push({
			id: row.id,
			slug: row.slug,
			kind: row.kind as UpdateKind,
			publishedAt: row.publishedAt,
			title: title.value,
			body: body.value,
			translationLocale: title.locale,
			isTranslationFallback: title.isFallback
		});
	}

	return result;
}

export interface AdminUpdate {
	id: string;
	slug: string;
	kind: UpdateKind;
	publishedAt: Date | null;
	translations: { locale: string; title: string; body: string }[];
	titles: Record<string, string>;
	subprocessorIds: string[];
}

export async function listUpdatesForAdmin(db: Db): Promise<AdminUpdate[]> {
	const rows = await db
		.select()
		.from(updatePost)
		.orderBy(desc(updatePost.publishedAt), asc(updatePost.slug));
	if (rows.length === 0) return [];

	const translations = await db
		.select()
		.from(updatePostTranslation)
		.where(
			inArray(
				updatePostTranslation.postId,
				rows.map((row) => row.id)
			)
		);

	const links = await db
		.select()
		.from(updatePostSubprocessor)
		.where(
			inArray(
				updatePostSubprocessor.postId,
				rows.map((row) => row.id)
			)
		);

	return rows.map((row) => {
		const mine = translations.filter((item) => item.postId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			kind: row.kind as UpdateKind,
			publishedAt: row.publishedAt,
			translations: mine.map((item) => ({
				locale: item.locale,
				title: item.title,
				body: item.body
			})),
			titles: Object.fromEntries(mine.map((item) => [item.locale, item.title])),
			subprocessorIds: links
				.filter((item) => item.postId === row.id)
				.map((item) => item.subprocessorId)
		};
	});
}

export async function getUpdateForAdmin(db: Db, id: string): Promise<AdminUpdate | null> {
	return (await listUpdatesForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createUpdate(
	db: Db,
	input: { slug: string; kind: UpdateKind; publishedAt?: Date | null }
): Promise<string> {
	const [row] = await db
		.insert(updatePost)
		.values({ slug: input.slug, kind: input.kind, publishedAt: input.publishedAt ?? null })
		.returning({ id: updatePost.id });

	if (!row) throw new Error('failed to insert update');
	return row.id;
}

export async function updateUpdate(
	db: Db,
	id: string,
	input: Partial<{ slug: string; kind: UpdateKind; publishedAt: Date | null }>
): Promise<void> {
	await db
		.update(updatePost)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(updatePost.id, id));
}

export async function deleteUpdate(db: Db, id: string): Promise<void> {
	await db.delete(updatePost).where(eq(updatePost.id, id));
}

export async function setUpdateTranslation(
	db: Db,
	postId: string,
	locale: string,
	values: { title: string; body: string }
): Promise<void> {
	await db
		.insert(updatePostTranslation)
		.values({ postId, locale, ...values })
		.onConflictDoUpdate({
			target: [updatePostTranslation.postId, updatePostTranslation.locale],
			set: values
		});
}

/** Replaces the link set wholesale — the form submits the complete list, the
 * same contract `setControlEvidence` has. */
export async function setUpdateSubprocessors(
	db: Db,
	postId: string,
	subprocessorIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(updatePostSubprocessor).where(eq(updatePostSubprocessor.postId, postId));
		if (subprocessorIds.length > 0) {
			await tx
				.insert(updatePostSubprocessor)
				.values(subprocessorIds.map((subprocessorId) => ({ postId, subprocessorId })));
		}
	});
}
