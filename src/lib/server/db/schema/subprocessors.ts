import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const subprocessor = pgTable('subprocessor', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	legalEntity: text('legal_entity').notNull(),
	/** ISO 3166-1 alpha-2, rendered through Intl.DisplayNames per locale. */
	country: text('country').notNull(),
	region: text('region').notNull(),
	hostingProvider: text('hosting_provider'),
	dpaUrl: text('dpa_url'),
	startedAt: timestamp('started_at', { withTimezone: true }),
	/** Set rather than deleted: a removed subprocessor is a disclosure, not an
	 * absence, and DACH data processing agreements frequently require notice. */
	endedAt: timestamp('ended_at', { withTimezone: true }),
	published: boolean('published').notNull().default(false),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const subprocessorTranslation = pgTable(
	'subprocessor_translation',
	{
		subprocessorId: uuid('subprocessor_id')
			.notNull()
			.references(() => subprocessor.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		purpose: text('purpose').notNull(),
		dataCategories: text('data_categories').notNull()
	},
	(table) => [primaryKey({ columns: [table.subprocessorId, table.locale] })]
);
