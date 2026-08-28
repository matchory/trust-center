import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const answer = pgTable(
	'answer',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		category: text('category').notNull(),
		// Internal by default: an answer written for a questionnaire reaches the
		// public FAQ only when somebody decides it should.
		visibility: text('visibility').notNull().default('internal'),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [check('answer_visibility_check', sql`${table.visibility} IN ('public', 'internal')`)]
);

export const answerTranslation = pgTable(
	'answer_translation',
	{
		answerId: uuid('answer_id')
			.notNull()
			.references(() => answer.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		question: text('question').notNull(),
		answer: text('answer').notNull()
	},
	(table) => [primaryKey({ columns: [table.answerId, table.locale] })]
);
