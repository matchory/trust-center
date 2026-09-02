import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subprocessor } from './subprocessors';
import { updatePost } from './updates';

/**
 * A subscriber is not a requester and there is deliberately no foreign key
 * between them (spec §4.1): `requester.purged_at` keeps a purged person's row
 * alive for the grants that reference it, so hanging a subscription off it
 * would resurrect a purged address into a live mailing list.
 *
 * Two tokens with opposite lifetimes, neither a `magic_link` row (P4.2). The
 * confirmation token expires — that expiry is what makes the sweep possible.
 * The management token never does: an unsubscribe link in a mail from eighteen
 * months ago must still work, and a dead one is a compliance defect.
 */
export const subscription = pgTable(
	'subscription',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Lowercased before insert, as `upsertRequester` does, so the unique
		// constraint is the real one rather than a case-sensitive near-miss.
		email: text('email').notNull().unique(),
		locale: text('locale').notNull(),
		confirmTokenHash: text('confirm_token_hash').unique(),
		confirmExpiresAt: timestamp('confirm_expires_at', { withTimezone: true }),
		confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
		// NOT hashed, unlike the confirmation token, and §4.2 is worth reading
		// before this looks like an oversight: every notice mail carries the
		// manage link, so the sending job has to be able to produce the token.
		// A one-way hash could be mailed once, at confirmation, and never again.
		manageToken: text('manage_token').unique(),
		lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Partial: the sweep only ever looks at the unconfirmed half.
		index('subscription_confirm_expires_idx')
			.on(table.confirmExpiresAt)
			.where(sql`${table.confirmedAt} IS NULL`),
		// For the notify tick's ORDER BY under its 500-row bound, NOT for the
		// join predicate (spec §8): the join drives from this table and
		// correlates into update_post, which already has update_post_published_idx.
		index('subscription_last_notified_idx')
			.on(table.lastNotifiedAt)
			.where(sql`${table.confirmedAt} IS NOT NULL`),
		// Confirmed is ONE state, not five columns that usually agree. Five
		// columns change together at confirmation and any one of them being
		// wrong is a silent defect, so each is paired against `confirmed_at`.
		check(
			'subscription_confirm_token_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.confirmTokenHash} IS NOT NULL)`
		),
		check(
			'subscription_confirm_expires_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.confirmExpiresAt} IS NOT NULL)`
		),
		check(
			'subscription_manage_token_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.manageToken} IS NULL)`
		),
		check(
			'subscription_cursor_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.lastNotifiedAt} IS NULL)`
		)
	]
);

/**
 * A join table rather than `topics[]` (P4.5): 3a settled the convention for
 * sets, the notification query wants a join rather than array containment, and
 * a check constraint on a column is a stronger guarantee than one on array
 * elements. The vocabulary is the closed set `update_post_kind_check` already
 * enforces — no new values are invented here.
 */
export const subscriptionTopic = pgTable(
	'subscription_topic',
	{
		subscriptionId: uuid('subscription_id')
			.notNull()
			.references(() => subscription.id, { onDelete: 'cascade' }),
		topic: text('topic').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.subscriptionId, table.topic] }),
		check(
			'subscription_topic_check',
			sql`${table.topic} IN ('document', 'subprocessor', 'certification', 'advisory')`
		)
	]
);

/**
 * Which post announces which subprocessor change (spec §7). It couples nothing:
 * the announcement is still a human-written post, and this only records the
 * link so that its *absence* is visible. Cascading from `subprocessor` is safe
 * and unlike the NDA template FKs of P3.16 unlocks nothing — no access is gated
 * on a row here.
 */
export const updatePostSubprocessor = pgTable(
	'update_post_subprocessor',
	{
		postId: uuid('post_id')
			.notNull()
			.references(() => updatePost.id, { onDelete: 'cascade' }),
		subprocessorId: uuid('subprocessor_id')
			.notNull()
			.references(() => subprocessor.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.postId, table.subprocessorId] })]
);
