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
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { DocumentStatus, DocumentTier } from '../../../content-types';
import { staffUser } from './staff';

// Re-exported so schema consumers need only one import; the values themselves
// live in src/lib/content-types.ts because components need them too.
export type { DocumentStatus, DocumentTier };

export const documentCategory = pgTable('document_category', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const documentCategoryTranslation = pgTable(
	'document_category_translation',
	{
		categoryId: uuid('category_id')
			.notNull()
			.references(() => documentCategory.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull()
	},
	(table) => [primaryKey({ columns: [table.categoryId, table.locale] })]
);

export const document = pgTable(
	'document',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		categoryId: uuid('category_id')
			.notNull()
			.references(() => documentCategory.id, { onDelete: 'cascade' }),
		// The gate is Phase 2; the column is here from the start so the portal
		// filters on it from the first query and the security test guarding that
		// filter is permanent rather than retrofitted.
		tier: text('tier').notNull().default('public'),
		status: text('status').notNull().default('draft'),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('document_category_idx').on(table.categoryId),
		check('document_tier_check', sql`${table.tier} IN ('public', 'request', 'nda')`),
		check('document_status_check', sql`${table.status} IN ('draft', 'published', 'archived')`)
	]
);

export const documentTranslation = pgTable(
	'document_translation',
	{
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		summary: text('summary')
	},
	(table) => [primaryKey({ columns: [table.documentId, table.locale] })]
);

export const documentFile = pgTable(
	'document_file',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		version: integer('version').notNull(),
		storageKey: text('storage_key').notNull(),
		sha256: text('sha256').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		validFrom: timestamp('valid_from', { withTimezone: true }),
		validUntil: timestamp('valid_until', { withTimezone: true }),
		isCurrent: boolean('is_current').notNull().default(false),
		uploadedByStaffId: uuid('uploaded_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('document_file_version_idx').on(table.documentId, table.locale, table.version),
		// Exactly one current file per (document, locale), enforced by the
		// database rather than by the code that swaps them.
		uniqueIndex('document_file_current_idx')
			.on(table.documentId, table.locale)
			.where(sql`${table.isCurrent}`)
	]
);
