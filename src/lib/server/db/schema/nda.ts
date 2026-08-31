import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * The agreement family. §12 deviation 1: the main spec's flat
 * `nda_template(version, locale, body_md, effective_from)` becomes separate
 * tables, because with more than one instrument "which agreement" and "which
 * version of it" are different questions.
 *
 * Never hard-deleted — `retired_at`, and every foreign key pointing here is
 * RESTRICT. Under the house convention of cascading joins, deleting a
 * superseded template would cascade its requirement rows away and make the
 * activation predicate vacuously true for every grant waiting on it: an
 * administrative tidy-up that is a silent bulk unlock.
 */
export const ndaTemplate = pgTable('nda_template', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	retiredAt: timestamp('retired_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * The requester-facing name (§5.6, P3.19). Three surfaces need it and none can
 * use the slug: the click-through heading, the approver's requirement list, and
 * §5.2's blocked reason on the admin grant list. §4.4's union means a signatory
 * routinely faces more than one agreement at once, which is what makes naming
 * them load-bearing rather than decorative.
 */
export const ndaTemplateTranslation = pgTable(
	'nda_template_translation',
	{
		templateId: uuid('template_id')
			.notNull()
			.references(() => ndaTemplate.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.templateId, table.locale] })]
);

/**
 * `effective_from` is NULL until published. Publishing is a deliberate,
 * separate, all-or-nothing act (§5.4), and a draft with no bodies must not be
 * reachable by `effectiveVersion`.
 *
 * `first_accepted_at` is the immutability marker: before it, a version may be
 * edited freely; after it, the operator publishes a new version instead.
 */
export const ndaTemplateVersion = pgTable(
	'nda_template_version',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		templateId: uuid('template_id')
			.notNull()
			.references(() => ndaTemplate.id, { onDelete: 'restrict' }),
		version: integer('version').notNull(),
		effectiveFrom: timestamp('effective_from', { withTimezone: true }),
		firstAcceptedAt: timestamp('first_accepted_at', { withTimezone: true }),
		retiredAt: timestamp('retired_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('nda_template_version_template_idx').on(table.templateId, table.effectiveFrom),
		check('nda_template_version_number_check', sql`${table.version} >= 1`)
	]
);

/**
 * One row per locale. §5.2: a version is effective only when every enabled
 * locale has a body, because otherwise two people who both "accepted the
 * current NDA" are bound by different documents depending on which language
 * their browser asked for. That is a legal problem, not a modelling preference.
 *
 * `sha256` is computed over the stored body at save time and copied onto every
 * acceptance, so the evidence pins the exact bytes the signatory saw.
 */
export const ndaTemplateBody = pgTable(
	'nda_template_body',
	{
		versionId: uuid('version_id')
			.notNull()
			.references(() => ndaTemplateVersion.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		bodyMd: text('body_md').notNull(),
		sha256: text('sha256').notNull()
	},
	(table) => [primaryKey({ columns: [table.versionId, table.locale] })]
);
