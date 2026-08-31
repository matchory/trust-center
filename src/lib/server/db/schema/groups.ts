import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { document } from './documents';
import { ndaTemplate } from './nda';

/**
 * A named, reusable bundle of documents — a saved scope — not a cohort of
 * people (design §4.2). Conveyor attaches group membership to the visitor
 * because their flow is "invite a company, it sees its cohort's documents";
 * this product already has a grant carrying an explicit document list, so a
 * people axis would duplicate it.
 */
export const accessGroup = pgTable('access_group', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	/**
	 * The agreement this bundle carries, if any. RESTRICT rather than the house
	 * cascade: deleting a template out from under a group would remove the
	 * requirement rows that reference it and make "every recorded requirement is
	 * satisfied" vacuously true for every grant waiting on it. Templates retire
	 * (P3.16); they do not delete.
	 */
	ndaTemplateId: uuid('nda_template_id').references(() => ndaTemplate.id, {
		onDelete: 'restrict'
	}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const accessGroupTranslation = pgTable(
	'access_group_translation',
	{
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.groupId, table.locale] })]
);

export const documentGroup = pgTable(
	'document_group',
	{
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'cascade' })
	},
	(table) => [
		primaryKey({ columns: [table.documentId, table.groupId] }),
		// Grant resolution asks "which documents are in these groups", which is
		// the reverse of the primary key's leading column.
		index('document_group_group_idx').on(table.groupId)
	]
);
