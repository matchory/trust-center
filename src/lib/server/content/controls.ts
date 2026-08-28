import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ControlStatus } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import {
	control,
	controlEvidence,
	controlGroup,
	controlGroupTranslation,
	controlTranslation,
	document,
	documentTranslation
} from '../db/schema';

export interface PublicControlEvidence {
	id: string;
	slug: string;
	title: string;
}

export interface PublicControl {
	id: string;
	slug: string;
	status: ControlStatus;
	title: string;
	description: string | null;
	translationLocale: string;
	isTranslationFallback: boolean;
	evidence: PublicControlEvidence[];
}

export interface PublicControlGroup {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	nameLocale: string;
	isNameFallback: boolean;
	controls: PublicControl[];
}

export async function listPublicControlGroups(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicControlGroup[]> {
	const rows = await db
		.select({
			groupId: controlGroup.id,
			groupSlug: controlGroup.slug,
			controlId: control.id,
			controlSlug: control.slug,
			status: control.status
		})
		.from(control)
		.innerJoin(controlGroup, eq(control.groupId, controlGroup.id))
		.where(eq(control.published, true))
		.orderBy(
			asc(controlGroup.position),
			asc(controlGroup.slug),
			asc(control.position),
			asc(control.slug)
		);

	if (rows.length === 0) return [];

	const controlIds = rows.map((row) => row.controlId);
	const groupIds = [...new Set(rows.map((row) => row.groupId))];

	const [groupNames, titles, evidence] = await Promise.all([
		db
			.select()
			.from(controlGroupTranslation)
			.where(inArray(controlGroupTranslation.groupId, groupIds)),
		db.select().from(controlTranslation).where(inArray(controlTranslation.controlId, controlIds)),
		// Evidence is filtered to publicly visible documents here, in the query.
		// A control may cite a gated document internally; naming one on the
		// portal would leak both its existence and its title.
		db
			.select({
				controlId: controlEvidence.controlId,
				documentId: document.id,
				slug: document.slug,
				locale: documentTranslation.locale,
				title: documentTranslation.title
			})
			.from(controlEvidence)
			.innerJoin(document, eq(controlEvidence.documentId, document.id))
			.innerJoin(documentTranslation, eq(documentTranslation.documentId, document.id))
			.where(
				and(
					inArray(controlEvidence.controlId, controlIds),
					eq(document.tier, 'public'),
					eq(document.status, 'published')
				)
			)
	]);

	const result: PublicControlGroup[] = [];

	for (const groupId of groupIds) {
		const picked = pickTranslation(
			groupNames
				.filter((row) => row.groupId === groupId)
				.map((row) => ({ locale: row.locale, value: row })),
			opts.locale,
			opts.defaultLocale
		);
		if (!picked) continue;

		const controls: PublicControl[] = [];

		for (const row of rows.filter((candidate) => candidate.groupId === groupId)) {
			const pickedTitle = pickTranslation(
				titles
					.filter((translation) => translation.controlId === row.controlId)
					.map((translation) => ({ locale: translation.locale, value: translation })),
				opts.locale,
				opts.defaultLocale
			);
			if (!pickedTitle) continue;

			const seen = new Set<string>();
			const linked: PublicControlEvidence[] = [];

			for (const item of evidence.filter((candidate) => candidate.controlId === row.controlId)) {
				if (seen.has(item.documentId)) continue;
				const pickedDocTitle = pickTranslation(
					evidence
						.filter((candidate) => candidate.documentId === item.documentId)
						.map((candidate) => ({ locale: candidate.locale, value: candidate.title })),
					opts.locale,
					opts.defaultLocale
				);
				if (!pickedDocTitle) continue;

				seen.add(item.documentId);
				linked.push({ id: item.documentId, slug: item.slug, title: pickedDocTitle.value });
			}

			controls.push({
				id: row.controlId,
				slug: row.controlSlug,
				status: row.status as ControlStatus,
				title: pickedTitle.value.title,
				description: pickedTitle.value.description,
				translationLocale: pickedTitle.locale,
				isTranslationFallback: pickedTitle.isFallback,
				evidence: linked
			});
		}

		if (controls.length === 0) continue;

		result.push({
			id: groupId,
			slug: rows.find((row) => row.groupId === groupId)?.groupSlug ?? '',
			name: picked.value.name,
			description: picked.value.description,
			nameLocale: picked.locale,
			isNameFallback: picked.isFallback,
			controls
		});
	}

	return result;
}

export interface AdminControl {
	id: string;
	slug: string;
	groupId: string;
	status: ControlStatus;
	published: boolean;
	position: number;
	translations: { locale: string; title: string; description: string | null }[];
	titles: Record<string, string>;
	evidenceDocumentIds: string[];
}

export async function listControlsForAdmin(db: Db): Promise<AdminControl[]> {
	const rows = await db.select().from(control).orderBy(asc(control.position), asc(control.slug));
	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);
	const [translations, evidence] = await Promise.all([
		db.select().from(controlTranslation).where(inArray(controlTranslation.controlId, ids)),
		db.select().from(controlEvidence).where(inArray(controlEvidence.controlId, ids))
	]);

	return rows.map((row) => {
		const mine = translations.filter((translation) => translation.controlId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			groupId: row.groupId,
			status: row.status as ControlStatus,
			published: row.published,
			position: row.position,
			translations: mine.map((t) => ({
				locale: t.locale,
				title: t.title,
				description: t.description
			})),
			titles: Object.fromEntries(mine.map((t) => [t.locale, t.title])),
			evidenceDocumentIds: evidence
				.filter((item) => item.controlId === row.id)
				.map((item) => item.documentId)
		};
	});
}

export async function getControlForAdmin(db: Db, id: string): Promise<AdminControl | null> {
	return (await listControlsForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createControl(
	db: Db,
	input: { slug: string; groupId: string; status?: ControlStatus; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(control)
		.values({
			slug: input.slug,
			groupId: input.groupId,
			status: input.status ?? 'planned',
			position: input.position ?? 0
		})
		.returning({ id: control.id });

	if (!row) throw new Error('failed to insert control');
	return row.id;
}

export async function updateControl(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		groupId: string;
		status: ControlStatus;
		published: boolean;
		position: number;
	}>
): Promise<void> {
	await db
		.update(control)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(control.id, id));
}

export async function deleteControl(db: Db, id: string): Promise<void> {
	await db.delete(control).where(eq(control.id, id));
}

export async function setControlTranslation(
	db: Db,
	controlId: string,
	locale: string,
	values: { title: string; description: string | null }
): Promise<void> {
	await db
		.insert(controlTranslation)
		.values({ controlId, locale, ...values })
		.onConflictDoUpdate({
			target: [controlTranslation.controlId, controlTranslation.locale],
			set: values
		});
}

/** Replaces the evidence set wholesale — the form submits the complete list. */
export async function setControlEvidence(
	db: Db,
	controlId: string,
	documentIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(controlEvidence).where(eq(controlEvidence.controlId, controlId));
		if (documentIds.length > 0) {
			await tx
				.insert(controlEvidence)
				.values(documentIds.map((documentId) => ({ controlId, documentId })));
		}
	});
}

export interface AdminControlGroup {
	id: string;
	slug: string;
	position: number;
	names: Record<string, string>;
	translations: { locale: string; name: string; description: string | null }[];
}

export async function listControlGroups(db: Db): Promise<AdminControlGroup[]> {
	const rows = await db
		.select()
		.from(controlGroup)
		.orderBy(asc(controlGroup.position), asc(controlGroup.slug));
	if (rows.length === 0) return [];

	const names = await db.select().from(controlGroupTranslation);

	return rows.map((row) => {
		const mine = names.filter((name) => name.groupId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			position: row.position,
			names: Object.fromEntries(mine.map((name) => [name.locale, name.name])),
			translations: mine.map((name) => ({
				locale: name.locale,
				name: name.name,
				description: name.description
			}))
		};
	});
}

export async function createControlGroup(
	db: Db,
	input: { slug: string; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(controlGroup)
		.values({ slug: input.slug, position: input.position ?? 0 })
		.returning({ id: controlGroup.id });

	if (!row) throw new Error('failed to insert control group');
	return row.id;
}

export async function updateControlGroup(
	db: Db,
	id: string,
	input: Partial<{ slug: string; position: number }>
): Promise<void> {
	await db.update(controlGroup).set(input).where(eq(controlGroup.id, id));
}

export async function setControlGroupTranslation(
	db: Db,
	groupId: string,
	locale: string,
	values: { name: string; description: string | null }
): Promise<void> {
	await db
		.insert(controlGroupTranslation)
		.values({ groupId, locale, ...values })
		.onConflictDoUpdate({
			target: [controlGroupTranslation.groupId, controlGroupTranslation.locale],
			set: values
		});
}

export async function deleteControlGroup(db: Db, id: string): Promise<void> {
	await db.delete(controlGroup).where(eq(controlGroup.id, id));
}
