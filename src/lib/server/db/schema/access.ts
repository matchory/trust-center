import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import type {
	AccessRequestSource,
	AccessRequestStatus,
	AccessRuleAction
} from '../../../access-types';
import { document } from './documents';
import { accessGroup } from './groups';
import { requester } from './requesters';
import { staffUser } from './staff';

export type { AccessRequestSource, AccessRequestStatus, AccessRuleAction };

export const accessRule = pgTable(
	'access_rule',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// An exact domain (`acme.example`) or one leading wildcard
		// (`*.acme.example`). Not a glob: every spec §9.3 example is a domain, and
		// a general engine invites patterns nobody can reason about at decision
		// time — which is the moment a stranger is given documents.
		pattern: text('pattern').notNull(),
		action: text('action').notNull(),
		// Which tiers this rule may auto-approve is `access_rule_tier`, not a
		// column: a ceiling recomputes, and a set does not.
		// Lower runs first. Ties broken by the more specific pattern — see
		// matchRule(), which does not depend on row order.
		priority: integer('priority').notNull().default(100),
		note: text('note'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('access_rule_priority_idx').on(table.priority),
		check('access_rule_action_check', sql`${table.action} IN ('auto_approve', 'review', 'deny')`)
	]
);

export const accessRequest = pgTable(
	'access_request',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Null until the magic link is consumed: spec §9.2 makes verification the
		// act that creates the requester.
		requesterId: uuid('requester_id').references(() => requester.id, { onDelete: 'cascade' }),
		status: text('status').notNull().default('unverified'),
		justification: text('justification'),
		source: text('source').notNull().default('portal'),
		// Held inline while unverified, nulled by the verification transaction.
		// These three columns are the only place unverified personal data lives,
		// and the sweep job deletes the rows that are never verified.
		submittedEmail: text('submitted_email'),
		submittedName: text('submitted_name'),
		submittedCompany: text('submitted_company'),
		decidedByStaffId: uuid('decided_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		decidedAt: timestamp('decided_at', { withTimezone: true }),
		reason: text('reason'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('access_request_status_idx').on(table.status, table.createdAt),
		index('access_request_requester_idx').on(table.requesterId),
		check(
			'access_request_status_check',
			sql`${table.status} IN ('unverified', 'pending', 'info_requested', 'approved', 'denied')`
		),
		check('access_request_source_check', sql`${table.source} IN ('portal', 'invite')`),
		// The two states are mutually exclusive by construction: an unverified row
		// carries a submitted email and no requester; every other state carries a
		// requester and no submitted email. Enforced here so a partially applied
		// verification cannot leave a row that is quietly both.
		//
		// Written as a CASE rather than an equivalence between the two sides. An
		// equivalence is also satisfied when both sides are false, which let a
		// verified row keep its submitted email — the exact leak this constraint
		// exists to prevent, since nulling those columns is what verification is
		// for. An integration test covers both directions.
		check(
			'access_request_verification_check',
			sql`CASE WHEN ${table.status} = 'unverified'
			         THEN ${table.requesterId} IS NULL AND ${table.submittedEmail} IS NOT NULL
			         ELSE ${table.requesterId} IS NOT NULL AND ${table.submittedEmail} IS NULL
			    END`
		)
	]
);

export const accessRequestDocument = pgTable(
	'access_request_document',
	{
		requestId: uuid('request_id')
			.notNull()
			.references(() => accessRequest.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.requestId, table.documentId] })]
);

export const accessGrant = pgTable(
	'access_grant',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		requesterId: uuid('requester_id')
			.notNull()
			.references(() => requester.id, { onDelete: 'cascade' }),
		// The request this grant answers. Null for a staff-initiated invite.
		requestId: uuid('request_id').references(() => accessRequest.id, { onDelete: 'set null' }),
		// The clock a grant runs on once it starts, in days, recorded because the
		// approver chose it — re-deriving it from `defaultGrantDays()` later
		// would silently substitute whatever the setting says then, and
		// /admin/settings/access exists precisely so operators change it.
		termDays: integer('term_days').notNull(),
		grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		revokedByStaffId: uuid('revoked_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		// Set by the reminder job so a lapse notice goes out once, not once a tick.
		expiryReminderSentAt: timestamp('expiry_reminder_sent_at', { withTimezone: true })
	},
	(table) => [
		index('access_grant_requester_idx').on(table.requesterId),
		// The reminder job scans by expiry; the download path filters by it.
		index('access_grant_expires_idx').on(table.expiresAt),
		// NOT NULL alone would admit 0, which is a grant that expires the moment
		// it starts.
		check('access_grant_term_days_check', sql`${table.termDays} >= 1`)
	]
);

export const accessGrantDocument = pgTable(
	'access_grant_document',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.grantId, table.documentId] })]
);

/**
 * A scope's blanket tiers: "everything at this tier, including documents
 * published later". Three parallel sets — documents, tiers, groups — and
 * nothing implies anything else.
 *
 * A ranked ceiling was rejected because it recomputes: inserting a tier below
 * an existing one would retroactively widen every live grant above it, which
 * is the failure spec §9's domain-drift rule forbids.
 *
 * `public` is not admitted: a public document needs no grant, so a public
 * entry would be a scope row that grants nothing. `nda` is admitted because
 * `access_rule.max_tier` already stores it and the backfill must preserve what
 * an operator wrote; the application refuses to honour it until Phase 3b.
 */
const scopeTierCheck = sql`tier IN ('request', 'nda')`;

export const accessRequestTier = pgTable(
	'access_request_tier',
	{
		requestId: uuid('request_id')
			.notNull()
			.references(() => accessRequest.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.requestId, table.tier] }),
		check('access_request_tier_check', scopeTierCheck)
	]
);

export const accessGrantTier = pgTable(
	'access_grant_tier',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.grantId, table.tier] }),
		check('access_grant_tier_check', scopeTierCheck)
	]
);

/**
 * `restrict` on the group, deliberately unlike every other join here. A cascade
 * would silently narrow a live grant when an operator deleted a group, and the
 * requester would lose documents with nothing recording why. Restricting makes
 * the operator revoke or re-scope first.
 */
export const accessGrantGroup = pgTable(
	'access_grant_group',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'restrict' })
	},
	(table) => [primaryKey({ columns: [table.grantId, table.groupId] })]
);

export const accessRuleTier = pgTable(
	'access_rule_tier',
	{
		ruleId: uuid('rule_id')
			.notNull()
			.references(() => accessRule.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.ruleId, table.tier] }),
		check('access_rule_tier_check', scopeTierCheck)
	]
);
