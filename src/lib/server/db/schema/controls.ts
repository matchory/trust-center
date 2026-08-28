import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import { document } from './documents';

export const controlGroup = pgTable('control_group', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const controlGroupTranslation = pgTable(
	'control_group_translation',
	{
		groupId: uuid('group_id')
			.notNull()
			.references(() => controlGroup.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.groupId, table.locale] })]
);

export const control = pgTable(
	'control',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		groupId: uuid('group_id')
			.notNull()
			.references(() => controlGroup.id, { onDelete: 'cascade' }),
		status: text('status').notNull().default('planned'),
		// Controls have no draft/archived lifecycle the way documents do — a
		// control is either on the portal or it is not — so a boolean says what
		// is true instead of a three-state enum with one unused state.
		published: boolean('published').notNull().default(false),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('control_group_idx').on(table.groupId),
		check(
			'control_status_check',
			sql`${table.status} IN ('implemented', 'in_progress', 'planned', 'not_applicable')`
		)
	]
);

export const controlTranslation = pgTable(
	'control_translation',
	{
		controlId: uuid('control_id')
			.notNull()
			.references(() => control.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.controlId, table.locale] })]
);

/**
 * Spec §8's `evidence_document_ids`, as a join table rather than an array
 * column: a foreign key means a deleted document cannot leave a dangling
 * reference behind, which an array of ids cannot promise.
 */
export const controlEvidence = pgTable(
	'control_evidence',
	{
		controlId: uuid('control_id')
			.notNull()
			.references(() => control.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.controlId, table.documentId] })]
);
