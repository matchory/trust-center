import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { accessRequest } from './access';

/**
 * A requester exists only after email verification (spec §9.2), so every row
 * here is a *verified* identity. Unverified submissions live in access_request
 * until their link is consumed.
 */
export const requester = pgTable('requester', {
	id: uuid('id').primaryKey().defaultRandom(),
	// Lowercased by upsertRequester before it reaches the database, so the
	// unique constraint is the real one rather than a case-sensitive near-miss.
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	company: text('company').notNull(),
	// Derived from the email at verification and frozen there. Rules are matched
	// against the domain at decision time (spec §9's domain-drift case), so this
	// records what was matched, not what the address would resolve to today.
	companyDomain: text('company_domain').notNull(),
	// The locale this person used when they verified. Every mail we send them
	// renders in it (spec §7): a German prospect who used the German portal must
	// not receive English mail, and this is the only place that is recorded.
	locale: text('locale').notNull(),
	notes: text('notes'),
	firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
	// Set by purgeRequester. A purged requester keeps its row so grants and
	// requests retain referential integrity; the personal columns are blanked
	// and the audit events pseudonymized.
	purgedAt: timestamp('purged_at', { withTimezone: true })
});

export const MAGIC_LINK_PURPOSES = ['verify_request', 'sign_in'] as const;
export type MagicLinkPurpose = (typeof MAGIC_LINK_PURPOSES)[number];

export const magicLink = pgTable(
	'magic_link',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// The token itself is never stored. A database disclosure must not hand
		// the reader a working link.
		tokenHash: text('token_hash').notNull().unique(),
		// Null for `verify_request`: no requester exists until the link is used.
		requesterId: uuid('requester_id').references(() => requester.id, { onDelete: 'cascade' }),
		// Set for `verify_request`, so consuming the link knows which submission
		// it verifies. The thunk breaks the import cycle with access.ts, which
		// references `requester` in the other direction.
		requestId: uuid('request_id').references((): AnyPgColumn => accessRequest.id, {
			onDelete: 'cascade'
		}),
		purpose: text('purpose').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		consumedAt: timestamp('consumed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('magic_link_expires_idx').on(table.expiresAt),
		check('magic_link_purpose_check', sql`${table.purpose} IN ('verify_request', 'sign_in')`),
		// A sign_in link must name its requester; a verify_request link must not,
		// because the identity it will create does not exist yet.
		check(
			'magic_link_requester_check',
			sql`(${table.purpose} = 'sign_in') = (${table.requesterId} IS NOT NULL)`
		)
	]
);

export const requesterSession = pgTable(
	'requester_session',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		tokenHash: text('token_hash').notNull().unique(),
		requesterId: uuid('requester_id')
			.notNull()
			.references(() => requester.id, { onDelete: 'cascade' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		ip: text('ip'),
		ua: text('ua'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('requester_session_requester_idx').on(table.requesterId),
		// The cleanup job deletes by expiry; without this it scans.
		index('requester_session_expires_idx').on(table.expiresAt)
	]
);
