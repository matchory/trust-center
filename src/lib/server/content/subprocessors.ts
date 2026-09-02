import { asc, eq, inArray } from 'drizzle-orm';
import { pickTranslation } from '../../i18n/locale';
import { livePost } from './updates';
import type { Db } from '../db';
import {
	subprocessor,
	subprocessorTranslation,
	updatePost,
	updatePostSubprocessor
} from '../db/schema';

export interface PublicSubprocessor {
	id: string;
	slug: string;
	name: string;
	legalEntity: string;
	country: string;
	region: string;
	hostingProvider: string | null;
	dpaUrl: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	purpose: string;
	dataCategories: string;
	purposeLocale: string;
	isPurposeFallback: boolean;
}

/** Split rather than filtered: an ended entry stays visible under its own heading. */
export async function listPublicSubprocessors(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<{ current: PublicSubprocessor[]; former: PublicSubprocessor[] }> {
	const rows = await db
		.select()
		.from(subprocessor)
		.where(eq(subprocessor.published, true))
		.orderBy(asc(subprocessor.position), asc(subprocessor.name));

	if (rows.length === 0) return { current: [], former: [] };

	const translations = await db
		.select()
		.from(subprocessorTranslation)
		.where(
			inArray(
				subprocessorTranslation.subprocessorId,
				rows.map((row) => row.id)
			)
		);

	const now = Date.now();
	const current: PublicSubprocessor[] = [];
	const former: PublicSubprocessor[] = [];

	for (const row of rows) {
		const mine = translations.filter((item) => item.subprocessorId === row.id);

		const purpose = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.purpose })),
			opts.locale,
			opts.defaultLocale
		);
		if (!purpose) continue;

		const dataCategories = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.dataCategories })),
			opts.locale,
			opts.defaultLocale
		);
		if (!dataCategories) continue;

		const entry: PublicSubprocessor = {
			id: row.id,
			slug: row.slug,
			name: row.name,
			legalEntity: row.legalEntity,
			country: row.country,
			region: row.region,
			hostingProvider: row.hostingProvider,
			dpaUrl: row.dpaUrl,
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			purpose: purpose.value,
			dataCategories: dataCategories.value,
			purposeLocale: purpose.locale,
			isPurposeFallback: purpose.isFallback
		};

		if (row.endedAt === null || row.endedAt.getTime() > now) current.push(entry);
		else former.push(entry);
	}

	return { current, former };
}

export interface NewSubprocessor {
	slug: string;
	name: string;
	legalEntity: string;
	country: string;
	region: string;
	hostingProvider: string | null;
	dpaUrl: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	position?: number;
}

export interface AdminSubprocessor extends Omit<NewSubprocessor, 'position'> {
	id: string;
	published: boolean;
	position: number;
	translations: { locale: string; purpose: string; dataCategories: string }[];
	coverage: NoticeCoverage;
}

export type NoticeCoverage = 'addition-unannounced' | 'removal-unannounced' | null;

/**
 * Whether a subprocessor change has an announcement behind it (spec §7).
 * Computed from `published`, `started_at`, `ended_at` and the live covering
 * posts — no new state and no new timestamps.
 *
 * Deliberately not driven by `updated_at`: that column bumps on any edit, so a
 * typo fix in a hosting provider's name would raise a notice warning, and a
 * warning that fires on noise is one nobody reads (P4.10).
 *
 * `coveringPublishedAt` must already be filtered to LIVE posts — published_at
 * not null and not in the future. A draft or scheduled post is not coverage:
 * nobody has been told yet, and a warning that cleared the moment an
 * announcement was *written* would clear before the obligation is discharged.
 *
 * Both conditions are anchored to a window, not just a lower bound (P4.22).
 * The addition needs a covering post on/after `startedAt` AND — when there is
 * an `endedAt` — strictly before it. A post published on or after the removal
 * is evidence the removal was announced, not the addition: without that upper
 * bound, a subprocessor added silently and removed later *with* an
 * announcement would have its addition warning cleared retroactively by a
 * post announcing the opposite fact — the one case this exists for. (An
 * earlier version anchored only the lower bound and missed this; a lower
 * bound alone cannot reject a post that comes after the removal.)
 */
export function noticeCoverage(input: {
	published: boolean;
	startedAt: Date | null;
	endedAt: Date | null;
	coveringPublishedAt: readonly Date[];
}): NoticeCoverage {
	// An unpublished subprocessor was never disclosed, so nothing about it needs
	// announcing — including its removal. The operator sees `published: false`
	// in the same row and needs no second signal.
	if (!input.published) return null;

	// A covering post counts for a given event only if its publish date falls
	// in that event's window: on/after the event itself, and — for the
	// addition only — strictly before a later removal.
	const covers = (lower: Date | null, upper: Date | null): boolean =>
		input.coveringPublishedAt.some(
			(at) =>
				(lower === null || at.getTime() >= lower.getTime()) &&
				(upper === null || at.getTime() < upper.getTime())
		);

	// The removal first: it is the live obligation, and only one badge is shown.
	if (input.endedAt && !covers(input.endedAt, null)) return 'removal-unannounced';
	if (!covers(input.startedAt, input.endedAt)) return 'addition-unannounced';
	return null;
}

export async function listSubprocessorsForAdmin(db: Db): Promise<AdminSubprocessor[]> {
	const rows = await db
		.select()
		.from(subprocessor)
		.orderBy(asc(subprocessor.position), asc(subprocessor.name));
	if (rows.length === 0) return [];

	const translations = await db
		.select()
		.from(subprocessorTranslation)
		.where(
			inArray(
				subprocessorTranslation.subprocessorId,
				rows.map((row) => row.id)
			)
		);

	// The same predicate `listPublicUpdates` uses, and for the same reason: a
	// draft or scheduled post has told nobody anything yet.
	const covering = await db
		.select({
			subprocessorId: updatePostSubprocessor.subprocessorId,
			publishedAt: updatePost.publishedAt
		})
		.from(updatePostSubprocessor)
		.innerJoin(updatePost, eq(updatePost.id, updatePostSubprocessor.postId))
		.where(livePost());

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		legalEntity: row.legalEntity,
		country: row.country,
		region: row.region,
		hostingProvider: row.hostingProvider,
		dpaUrl: row.dpaUrl,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		published: row.published,
		position: row.position,
		translations: translations
			.filter((item) => item.subprocessorId === row.id)
			.map((item) => ({
				locale: item.locale,
				purpose: item.purpose,
				dataCategories: item.dataCategories
			})),
		coverage: noticeCoverage({
			published: row.published,
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			coveringPublishedAt: covering
				.filter((item) => item.subprocessorId === row.id)
				.map((item) => item.publishedAt)
				.filter((publishedAt): publishedAt is Date => publishedAt !== null)
		})
	}));
}

/**
 * Just enough to render a picker. The update editor links posts to
 * subprocessors by id, and `listSubprocessorsForAdmin` would charge that
 * checkbox list for every translation and for the notice-coverage join — work
 * only the subprocessor list page displays.
 */
export async function listSubprocessorOptions(
	db: Db
): Promise<{ id: string; slug: string; name: string }[]> {
	return db
		.select({ id: subprocessor.id, slug: subprocessor.slug, name: subprocessor.name })
		.from(subprocessor)
		.orderBy(asc(subprocessor.position), asc(subprocessor.name));
}

export async function getSubprocessorForAdmin(
	db: Db,
	id: string
): Promise<AdminSubprocessor | null> {
	return (await listSubprocessorsForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createSubprocessor(db: Db, input: NewSubprocessor): Promise<string> {
	const [row] = await db
		.insert(subprocessor)
		.values({ ...input, position: input.position ?? 0 })
		.returning({ id: subprocessor.id });

	if (!row) throw new Error('failed to insert subprocessor');
	return row.id;
}

export async function updateSubprocessor(
	db: Db,
	id: string,
	input: Partial<NewSubprocessor & { published: boolean; position: number }>
): Promise<void> {
	await db
		.update(subprocessor)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(subprocessor.id, id));
}

export async function deleteSubprocessor(db: Db, id: string): Promise<void> {
	await db.delete(subprocessor).where(eq(subprocessor.id, id));
}

export async function setSubprocessorTranslation(
	db: Db,
	subprocessorId: string,
	locale: string,
	values: { purpose: string; dataCategories: string }
): Promise<void> {
	await db
		.insert(subprocessorTranslation)
		.values({ subprocessorId, locale, ...values })
		.onConflictDoUpdate({
			target: [subprocessorTranslation.subprocessorId, subprocessorTranslation.locale],
			set: values
		});
}
