import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const auditEvent = pgTable(
	'audit_event',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Monotonic insertion order. `gen_random_uuid()` (the `id` column's
		// default) has no ordering relationship to insertion time, so same-
		// timestamp events order nondeterministically without this — and,
		// unlike a random id, a gap in `seq` makes a deleted row detectable.
		seq: bigserial('seq', { mode: 'bigint' }).unique(),
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
