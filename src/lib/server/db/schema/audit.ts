import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const auditEvent = pgTable(
	'audit_event',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
		actorType: text('actor_type').notNull(),
		actorId: text('actor_id'),
		action: text('action').notNull(),
		subjectType: text('subject_type'),
		subjectId: text('subject_id'),
		ip: text('ip'),
		ua: text('ua'),
		requestId: text('request_id'),
		meta: jsonb('meta')
	},
	(table) => [
		index('audit_event_subject_idx').on(table.subjectType, table.subjectId),
		index('audit_event_at_idx').on(table.at),
		index('audit_event_actor_idx').on(table.actorType, table.actorId)
	]
);
