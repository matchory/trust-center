import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { document } from './documents';

export const certification = pgTable('certification', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	framework: text('framework').notNull(),
	issuer: text('issuer').notNull(),
	validFrom: timestamp('valid_from', { withTimezone: true }),
	validUntil: timestamp('valid_until', { withTimezone: true }),
	// The certificate itself, if it is published as a document. `set null` so
	// deleting the document leaves the certification intact rather than
	// cascading away a compliance record.
	certificateDocumentId: uuid('certificate_document_id').references(() => document.id, {
		onDelete: 'set null'
	}),
	published: boolean('published').notNull().default(false),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const certificationTranslation = pgTable(
	'certification_translation',
	{
		certificationId: uuid('certification_id')
			.notNull()
			.references(() => certification.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		scope: text('scope').notNull()
	},
	(table) => [primaryKey({ columns: [table.certificationId, table.locale] })]
);
