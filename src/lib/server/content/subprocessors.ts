import { asc, eq, inArray } from 'drizzle-orm';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import { subprocessor, subprocessorTranslation } from '../db/schema';

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
			}))
	}));
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
