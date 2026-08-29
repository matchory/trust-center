import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A fixed window per key. Not a sliding window: the extra precision buys
 * nothing here, and a single upsert with no read-then-write is worth more than
 * exactness at the window boundary.
 *
 * Keys are hashed by the caller — see rateLimitKey(). A raw email address in
 * this table would be requester personal data in a place spec §10 never
 * anticipated, retained for as long as the window.
 */
export const rateLimit = pgTable(
	'rate_limit',
	{
		key: text('key').primaryKey(),
		windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
		count: integer('count').notNull().default(0)
	},
	(table) => [index('rate_limit_window_idx').on(table.windowStart)]
);
