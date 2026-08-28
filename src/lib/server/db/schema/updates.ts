import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const updatePost = pgTable(
	'update_post',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		kind: text('kind').notNull(),
		// Null means unpublished and a future value means scheduled — one column
		// answering both questions, so a post cannot be published and undated.
		publishedAt: timestamp('published_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('update_post_published_idx').on(table.publishedAt),
		check(
			'update_post_kind_check',
			sql`${table.kind} IN ('document', 'subprocessor', 'certification', 'advisory')`
		)
	]
);

export const updatePostTranslation = pgTable(
	'update_post_translation',
	{
		postId: uuid('post_id')
			.notNull()
			.references(() => updatePost.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull()
	},
	(table) => [primaryKey({ columns: [table.postId, table.locale] })]
);
