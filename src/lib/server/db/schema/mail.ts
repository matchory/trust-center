import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const OUTBOUND_EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type OutboundEmailStatus = (typeof OUTBOUND_EMAIL_STATUSES)[number];

/**
 * The queue and the record are the same row. `to` is requester personal data,
 * but this is a domain table rather than the audit log, so spec §10's `meta`
 * restriction does not apply — it is a column rather than buried in `payload`
 * precisely so purgeRequester can find and clear it.
 */
export const outboundEmail = pgTable(
	'outbound_email',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		to: text('to').notNull(),
		template: text('template').notNull(),
		locale: text('locale').notNull(),
		// Rendered at send time rather than at enqueue time, so a template fix
		// applies to mail that has not gone out yet.
		payload: jsonb('payload').notNull(),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastError: text('last_error'),
		sentAt: timestamp('sent_at', { withTimezone: true }),
		providerId: text('provider_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// The drain query's claim predicate. Partial, so the index stays small as
		// sent mail accumulates.
		index('outbound_email_claim_idx')
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'pending'`),
		check('outbound_email_status_check', sql`${table.status} IN ('pending', 'sent', 'failed')`)
	]
);
