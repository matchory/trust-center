import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const staffUser = pgTable(
	'staff_user',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		oidcSub: text('oidc_sub').notNull().unique(),
		email: text('email').notNull(),
		name: text('name').notNull(),
		role: text('role').notNull(),
		lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
		disabledAt: timestamp('disabled_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [check('staff_user_role_check', sql`${table.role} IN ('admin', 'approver')`)]
);

export const staffSession = pgTable(
	'staff_session',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		tokenHash: text('token_hash').notNull().unique(),
		staffUserId: uuid('staff_user_id')
			.notNull()
			.references(() => staffUser.id, { onDelete: 'cascade' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		ip: text('ip'),
		ua: text('ua'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('staff_session_user_idx').on(table.staffUserId)]
);
