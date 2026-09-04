import { sql } from 'drizzle-orm';
import {
	bigint,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * Both sinks are declared here although B1 implements only S3: adding the
 * syslog adapter in B2 must be an adapter, not a migration (spec §19).
 */
export const SINK_NAMES = ['s3', 'syslog'] as const;
export type SinkName = (typeof SINK_NAMES)[number];

/**
 * The closed set `last_error` may hold, assigned by the first matching rule in
 * spec §5.4. Never a provider message: the mail queue stores raw SMTP text and
 * it survives both a purge and the retention window (issue #11), which is the
 * failure this set exists to avoid.
 */
export const SHIPMENT_ERROR_REASONS = [
	'config',
	'tls',
	'timeout',
	'network',
	'auth',
	'permission',
	'not_found',
	'http_status'
] as const;
export type ShipmentErrorReason = (typeof SHIPMENT_ERROR_REASONS)[number];

/**
 * A batch of audit events, and the reader's cursor: the position is the
 * greatest `(cursor_xmin, cursor_seq)` in this table, so a crash between
 * "batch written" and "batch shipped" cannot leave the cursor ahead of any
 * batch (spec §2.1).
 *
 * `prev_cursor_*` is stored rather than derived because the rebuild on retry
 * needs the batch's exact range, and deriving it from "the previous row by
 * cursor order" would silently produce a different range after any anomaly
 * (spec §4.3).
 *
 * No `body` column, deliberately: persisting it would put ip, ua and actor_id
 * at rest in a second place purgeRequester does not clear (spec §2.3).
 */
export const auditBatch = pgTable(
	'audit_batch',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		cursorXmin: bigint('cursor_xmin', { mode: 'bigint' }).notNull(),
		cursorSeq: bigint('cursor_seq', { mode: 'bigint' }).notNull(),
		prevCursorXmin: bigint('prev_cursor_xmin', { mode: 'bigint' }).notNull(),
		prevCursorSeq: bigint('prev_cursor_seq', { mode: 'bigint' }).notNull(),
		rowCount: integer('row_count').notNull(),
		minSeq: bigint('min_seq', { mode: 'bigint' }).notNull(),
		maxSeq: bigint('max_seq', { mode: 'bigint' }).notNull(),
		byteCount: integer('byte_count').notNull(),
		digest: text('digest').notNull()
	},
	(table) => [
		unique('audit_batch_cursor_key').on(table.cursorXmin, table.cursorSeq),
		index('audit_batch_created_idx').on(table.createdAt)
	]
);

/** One row per (batch, sink). Pending until `shipped_at` is set — there is no
 * terminal failure state, because B may not give up (spec §2.2). */
export const auditBatchShipment = pgTable(
	'audit_batch_shipment',
	{
		batchId: uuid('batch_id')
			.notNull()
			.references(() => auditBatch.id),
		sink: text('sink').notNull(),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastError: text('last_error'),
		lastStatusCode: integer('last_status_code'),
		shippedAt: timestamp('shipped_at', { withTimezone: true }),
		objectKey: text('object_key'),
		digest: text('digest')
	},
	(table) => [
		primaryKey({ columns: [table.batchId, table.sink] }),
		// The claim predicate, partial for the reason outbound_email_claim_idx is:
		// the index stays small as shipped rows accumulate forever (spec §12).
		index('audit_batch_shipment_claim_idx')
			.on(table.sink, table.nextAttemptAt)
			.where(sql`${table.shippedAt} IS NULL`)
	]
);
