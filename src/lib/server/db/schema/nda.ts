import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';
import { accessGrant } from './access';
import { requester } from './requesters';
import { staffUser } from './staff';

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
		check('nda_template_version_number_check', sql`${table.version} >= 1`),
		unique('nda_template_version_template_id_version_unique').on(table.templateId, table.version)
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

/**
 * What a grant is waiting on, frozen at approval. A waiver is a recorded row
 * rather than an omitted one: §7.3's live delivery check re-derives what a
 * document currently requires, so an omitted requirement would be silently
 * re-imposed and the bypass would be useless. A recorded waiver is the grant's
 * answer to a requirement the document still carries.
 *
 * `nda_template_id` is RESTRICT: under a cascade, deleting a superseded
 * template would remove these rows and make "every recorded requirement is
 * satisfied" vacuously true for every grant waiting on it.
 */
export const accessGrantNda = pgTable(
	'access_grant_nda',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		ndaTemplateId: uuid('nda_template_id')
			.notNull()
			.references(() => ndaTemplate.id, { onDelete: 'restrict' }),
		disposition: text('disposition').notNull(),
		decidedByStaffId: uuid('decided_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		reason: text('reason')
	},
	(table) => [
		primaryKey({ columns: [table.grantId, table.ndaTemplateId] }),
		check('access_grant_nda_disposition_check', sql`${table.disposition} IN ('required', 'waived')`)
	]
);

/**
 * §6.1. `email`, `company` and `company_domain` are denormalized here at
 * acceptance time, and that is not duplication:
 *
 * - `purgeRequester` rewrites `requester.email` and blanks `company_domain`. A
 *   record retaining `typed_name` while losing the email is the worst of both —
 *   it still holds personal data and can no longer identify the contracting
 *   party by any means the database offers.
 * - Domain-scoped validity (§6.3) resolves through `company_domain`. Purging
 *   the one colleague who signed would otherwise revoke coverage for everyone
 *   else at that company, while the record proving it still exists.
 *
 * `method` admits only 'clickthrough'. It widens when something can produce
 * another value — deliberately unlike Phase 1's `tier` CHECK, which admitted
 * 'nda' a phase early and then needed a clamp to stay safe.
 */
export const ndaAcceptance = pgTable(
	'nda_acceptance',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		requesterId: uuid('requester_id')
			.notNull()
			.references(() => requester.id, { onDelete: 'cascade' }),
		versionId: uuid('version_id')
			.notNull()
			.references(() => ndaTemplateVersion.id, { onDelete: 'restrict' }),
		method: text('method').notNull().default('clickthrough'),
		acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
		ip: text('ip'),
		ua: text('ua'),
		typedName: text('typed_name').notNull(),
		email: text('email').notNull(),
		company: text('company').notNull(),
		companyDomain: text('company_domain').notNull(),
		templateSha256: text('template_sha256').notNull(),
		recordPdfKey: text('record_pdf_key')
	},
	(table) => [
		// A double-submit is idempotent rather than a second record.
		unique('nda_acceptance_person_version_key').on(table.requesterId, table.versionId),
		index('nda_acceptance_domain_idx').on(table.companyDomain),
		check('nda_acceptance_method_check', sql`${table.method} IN ('clickthrough')`)
	]
);

/**
 * Which acceptance activated which grant. Written by activation, not by
 * acceptance (§12 deviation 11): an acceptance is a fact about a person and a
 * version; *which grants it activated* is a fact about that activation, and a
 * grant may activate months after the acceptance it relies on.
 */
export const accessGrantAcceptance = pgTable(
	'access_grant_acceptance',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		acceptanceId: uuid('acceptance_id')
			.notNull()
			.references(() => ndaAcceptance.id, { onDelete: 'restrict' })
	},
	(table) => [primaryKey({ columns: [table.grantId, table.acceptanceId] })]
);
