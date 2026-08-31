import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseAgreementBody } from '../../markdown/subset';
import { groupByKey } from '../collections';
import {
	ndaTemplate,
	ndaTemplateBody,
	ndaTemplateTranslation,
	ndaTemplateVersion
} from '../db/schema';
import type { Db } from '../db';

/** A version that has been signed cannot change; the operator publishes a new one. */
export class VersionImmutable extends Error {}

/** §5.2: a version is effective only when every enabled locale has a body. */
export class VersionIncomplete extends Error {}

/** The same slug shape every other content type uses. */
export const templateSchema = z.object({
	slug: z
		.string()
		.trim()
		.min(1)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
});

export type TemplateInput = z.output<typeof templateSchema>;

export interface TemplateVersionRow {
	id: string;
	version: number;
	effectiveFrom: Date | null;
	firstAcceptedAt: Date | null;
	retiredAt: Date | null;
	locales: string[];
}

export interface AdminTemplateRow {
	id: string;
	slug: string;
	names: Record<string, string>;
	retiredAt: Date | null;
	effectiveVersionNumber: number | null;
	/** Enabled locales the newest published version has no body for (§5.2). */
	blockedLocales: string[];
}

export interface AdminTemplateDetail extends AdminTemplateRow {
	descriptions: Record<string, string>;
	versions: TemplateVersionRow[];
}

export interface EffectiveVersion {
	versionId: string;
	version: number;
	bodies: Record<string, { bodyMd: string; sha256: string }>;
}

function sha256Of(body: string): string {
	return createHash('sha256').update(body, 'utf8').digest('hex');
}

export async function createTemplate(db: Db, input: TemplateInput): Promise<string> {
	const [row] = await db
		.insert(ndaTemplate)
		.values({ slug: input.slug })
		.returning({ id: ndaTemplate.id });

	if (!row) throw new Error('failed to create template');
	return row.id;
}

export async function updateTemplate(db: Db, id: string, input: TemplateInput): Promise<void> {
	await db.update(ndaTemplate).set({ slug: input.slug }).where(eq(ndaTemplate.id, id));
}

export async function setTemplateTranslation(
	db: Db,
	id: string,
	locale: string,
	values: { name: string; description: string | null }
): Promise<void> {
	await db
		.insert(ndaTemplateTranslation)
		.values({ templateId: id, locale, ...values })
		.onConflictDoUpdate({
			target: [ndaTemplateTranslation.templateId, ndaTemplateTranslation.locale],
			set: values
		});
}

/** Retired, never deleted (P3.16). Every FK pointing here is RESTRICT. */
export async function retireTemplate(db: Db, id: string): Promise<void> {
	await db.update(ndaTemplate).set({ retiredAt: new Date() }).where(eq(ndaTemplate.id, id));
}

/**
 * The next version number for this family. Under READ COMMITTED — the
 * default, and what `createDb` leaves in place — a plain transaction does not
 * stop two concurrent calls both reading the same max and both inserting the
 * same next number: it only bundles the read and the write atomically for
 * *this* call, not against a concurrent one. What actually serializes two
 * operators is the `SELECT ... FOR UPDATE` on the template row below, which
 * makes the second call block until the first commits and then re-read the
 * now-higher max; `nda_template_version_template_id_version_unique` is the
 * backstop if anything ever bypasses this function.
 */
export async function createVersion(
	db: Db,
	templateId: string
): Promise<{ versionId: string; version: number }> {
	return db.transaction(async (tx) => {
		await tx.select().from(ndaTemplate).where(eq(ndaTemplate.id, templateId)).for('update');

		const [current] = await tx
			.select({ highest: max(ndaTemplateVersion.version) })
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.templateId, templateId));

		const version = (current?.highest ?? 0) + 1;

		const [row] = await tx
			.insert(ndaTemplateVersion)
			.values({ templateId, version })
			.returning({ id: ndaTemplateVersion.id });

		if (!row) throw new Error('failed to create version');
		return { versionId: row.id, version };
	});
}

/**
 * Validates against the subset *before* storing, so a body that cannot be
 * rendered never becomes a version somebody is asked to sign. The hash is over
 * the stored bytes, which is what the acceptance record pins.
 */
export async function setVersionBody(
	db: Db,
	versionId: string,
	locale: string,
	bodyMd: string
): Promise<{ sha256: string }> {
	parseAgreementBody(bodyMd);

	return db.transaction(async (tx) => {
		const [version] = await tx
			.select({ firstAcceptedAt: ndaTemplateVersion.firstAcceptedAt })
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.id, versionId))
			.limit(1);

		if (!version) throw new Error('no such version');
		if (version.firstAcceptedAt) {
			throw new VersionImmutable('this version has been accepted and can no longer be edited');
		}

		const sha256 = sha256Of(bodyMd);

		await tx
			.insert(ndaTemplateBody)
			.values({ versionId, locale, bodyMd, sha256 })
			.onConflictDoUpdate({
				target: [ndaTemplateBody.versionId, ndaTemplateBody.locale],
				set: { bodyMd, sha256 }
			});

		return { sha256 };
	});
}

/**
 * All-or-nothing (§5.2). `locales` is the *enabled* set, passed in rather than
 * read from config: a module that needs a configured environment to answer a
 * question about rows is untestable, and the route owns that lookup.
 */
export async function publishVersion(
	db: Db,
	versionId: string,
	locales: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		const bodies = await tx
			.select({ locale: ndaTemplateBody.locale })
			.from(ndaTemplateBody)
			.where(eq(ndaTemplateBody.versionId, versionId));

		const have = new Set(bodies.map((row) => row.locale));
		const missing = locales.filter((locale) => !have.has(locale));

		if (missing.length > 0) throw new VersionIncomplete(`no body for: ${missing.join(', ')}`);

		// The database's clock, not the application's. `effectiveVersion` asks
		// `effective_from <= now()` in Postgres, so stamping this from Node makes
		// the comparison span two clocks: with the database even milliseconds
		// behind, a version just published is briefly not yet in force — and
		// nobody can be shown the agreement they were just told to sign.
		await tx
			.update(ndaTemplateVersion)
			.set({ effectiveFrom: sql`now()` })
			.where(eq(ndaTemplateVersion.id, versionId));
	});
}

/**
 * The version a requester would be shown right now: published, in force, not
 * retired, and complete in every enabled locale.
 *
 * Completeness is re-checked here rather than trusted from publish, because
 * `LOCALES` can gain a locale after a version was published. §5.2 requires that
 * to surface rather than leave a requester on an "unavailable" page while
 * `acceptance_due_at` ticks down with nobody told.
 */
export async function effectiveVersion(
	db: Db,
	templateId: string,
	locales: readonly string[]
): Promise<EffectiveVersion | null> {
	const candidates = await db
		.select({ id: ndaTemplateVersion.id, version: ndaTemplateVersion.version })
		.from(ndaTemplateVersion)
		.where(
			and(
				eq(ndaTemplateVersion.templateId, templateId),
				isNull(ndaTemplateVersion.retiredAt),
				lte(ndaTemplateVersion.effectiveFrom, sql`now()`)
			)
		)
		.orderBy(desc(ndaTemplateVersion.effectiveFrom));

	if (candidates.length === 0) return null;

	const bodyRows = await db
		.select()
		.from(ndaTemplateBody)
		.where(
			inArray(
				ndaTemplateBody.versionId,
				candidates.map((row) => row.id)
			)
		);

	const byVersion = groupByKey(bodyRows, (row) => row.versionId);

	for (const candidate of candidates) {
		const bodies: Record<string, { bodyMd: string; sha256: string }> = {};
		for (const row of byVersion.get(candidate.id) ?? []) {
			bodies[row.locale] = { bodyMd: row.bodyMd, sha256: row.sha256 };
		}

		if (locales.every((locale) => bodies[locale])) {
			return { versionId: candidate.id, version: candidate.version, bodies };
		}
	}

	return null;
}

export async function listTemplates(
	db: Db,
	locales: readonly string[]
): Promise<AdminTemplateRow[]> {
	const rows = await db.select().from(ndaTemplate).orderBy(asc(ndaTemplate.slug));
	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);

	// Three batched queries, not three per row — the same shape `listGroups` uses.
	const [names, versions, bodies] = await Promise.all([
		db.select().from(ndaTemplateTranslation).where(inArray(ndaTemplateTranslation.templateId, ids)),
		db
			.select({
				id: ndaTemplateVersion.id,
				templateId: ndaTemplateVersion.templateId,
				version: ndaTemplateVersion.version
			})
			.from(ndaTemplateVersion)
			.where(
				and(
					inArray(ndaTemplateVersion.templateId, ids),
					isNull(ndaTemplateVersion.retiredAt),
					lte(ndaTemplateVersion.effectiveFrom, sql`now()`)
				)
			),
		db
			.select({ versionId: ndaTemplateBody.versionId, locale: ndaTemplateBody.locale })
			.from(ndaTemplateBody)
			.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaTemplateBody.versionId))
			.where(inArray(ndaTemplateVersion.templateId, ids))
	]);

	const nameRows = groupByKey(names, (row) => row.templateId);
	const versionRows = groupByKey(versions, (row) => row.templateId);
	const localeRows = groupByKey(bodies, (row) => row.versionId);

	return rows.map((row) => {
		// Completeness decides effectiveness here exactly as it does in
		// `effectiveVersion`. Reporting the highest *published* version instead
		// would have this page say "version 3 effective" while the click-through
		// refuses to render it — which is the invisible failure §5.2 exists to
		// prevent, and the admin list is where it has to become visible.
		const candidates = (versionRows.get(row.id) ?? []).sort((a, b) => b.version - a.version);

		let effectiveVersionNumber: number | null = null;
		let blockedLocales: string[] = [];

		for (const candidate of candidates) {
			const have = new Set((localeRows.get(candidate.id) ?? []).map((entry) => entry.locale));
			const missing = locales.filter((locale) => !have.has(locale));

			if (missing.length === 0) {
				effectiveVersionNumber = candidate.version;
				blockedLocales = [];
				break;
			}

			// Remember the newest blocked candidate, so the page can name what is
			// missing rather than only saying there is nothing effective.
			if (blockedLocales.length === 0) blockedLocales = missing;
		}

		return {
			id: row.id,
			slug: row.slug,
			retiredAt: row.retiredAt,
			names: Object.fromEntries((nameRows.get(row.id) ?? []).map((n) => [n.locale, n.name])),
			effectiveVersionNumber,
			blockedLocales
		};
	});
}

export async function getTemplate(
	db: Db,
	id: string,
	locales: readonly string[]
): Promise<AdminTemplateDetail | null> {
	const row = (await listTemplates(db, locales)).find((entry) => entry.id === id);
	if (!row) return null;

	const [translations, versions, bodies] = await Promise.all([
		db.select().from(ndaTemplateTranslation).where(eq(ndaTemplateTranslation.templateId, id)),
		db
			.select()
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.templateId, id))
			.orderBy(desc(ndaTemplateVersion.version)),
		db
			.select({ versionId: ndaTemplateBody.versionId, locale: ndaTemplateBody.locale })
			.from(ndaTemplateBody)
			.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaTemplateBody.versionId))
			.where(eq(ndaTemplateVersion.templateId, id))
	]);

	const localesByVersion = groupByKey(bodies, (entry) => entry.versionId);

	return {
		...row,
		descriptions: Object.fromEntries(
			translations
				.filter((entry) => entry.description !== null)
				.map((entry) => [entry.locale, entry.description!])
		),
		versions: versions.map((version) => ({
			id: version.id,
			version: version.version,
			effectiveFrom: version.effectiveFrom,
			firstAcceptedAt: version.firstAcceptedAt,
			retiredAt: version.retiredAt,
			locales: (localesByVersion.get(version.id) ?? []).map((entry) => entry.locale).sort()
		}))
	};
}
