import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
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
 * The wire shapes a formatter exists for. A column rather than two branches so
 * adding Slack later is one file, one entry here, and one value in the
 * migration's ALTER — see the sync caveat on the check constraint below.
 */
export const EGRESS_FORMATS = ['generic', 'teams'] as const;
export type EgressFormat = (typeof EGRESS_FORMATS)[number];

/**
 * The closed set `last_error` may hold. A fixed phrase and never a response
 * body: a receiver that echoes its input — n8n's "respond with incoming
 * items", most webhook debuggers — would otherwise write a requester's name
 * and address into a column purgeRequester does not know about, creating the
 * second erasure path this table's reference-not-payload shape exists to
 * avoid (spec §2.3, §6.4).
 */
export const DELIVERY_ERROR_REASONS = [
	'http_status',
	'redirect_refused',
	'destination_denied',
	'timeout',
	'network',
	'signing_key_missing',
	'body_too_large',
	// The stored URL no longer satisfies `validateEndpointUrl` — an allowlist
	// entry withdrawn under a row that was valid when it was saved. Distinct
	// from `destination_denied`, which is about where the host *resolves*.
	'url',
	// `EVENT_EGRESS_ENABLED` is off. Never reached by the delivery path, which
	// claims nothing while the switch is off; this is what the admin test send
	// records instead of calling out.
	'egress_disabled'
] as const;
export type DeliveryErrorReason = (typeof DELIVERY_ERROR_REASONS)[number];

/**
 * The noun is "endpoint" throughout: `subscription` is already the portal's
 * update mailing list, and two unrelated concepts sharing a name in one schema
 * is how a later reader joins the wrong table (spec §2).
 */
export const eventEndpoint = pgTable(
	'event_endpoint',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// The operator's label. Deliberately NOT a telemetry attribute (spec §10):
		// unvalidated free text in a metric label is how an address ends up in a
		// monitoring platform.
		name: text('name').notNull(),
		url: text('url').notNull(),
		format: text('format').notNull(),
		// Bumping this re-keys this endpoint alone; rotating EVENT_SIGNING_KEY
		// re-keys every endpoint at once (spec §7.1).
		secretVersion: integer('secret_version').notNull().default(1),
		enabled: boolean('enabled').notNull().default(true),
		/**
		 * One keyset cursor over audit_event in two columns, ordered
		 * `(xmin, seq)`. NOT a `seq` high-watermark: `nextval()` is consumed at
		 * INSERT and a row becomes visible at COMMIT, and because recordEvent is
		 * called last in a transaction those two orders diverge — a seq cursor
		 * silently drops an event committed out of order (plan C1, spec §5.2).
		 *
		 * Set at creation to the current xmin horizon, which is what makes "a new
		 * endpoint does not replay eighteen months of history into a Teams
		 * channel" a property of the insert rather than a hope.
		 */
		cursorXmin: bigint('cursor_xmin', { mode: 'bigint' }).notNull(),
		// A SQL default rather than `.default(0n)`: drizzle-kit's snapshot diff
		// JSON.stringifies the default, and JSON has no BigInt representation —
		// `.default(0n)` crashes `db:generate` outright. Runtime behaviour is
		// identical (Postgres sees `DEFAULT 0` either way).
		cursorSeq: bigint('cursor_seq', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
		disabledAt: timestamp('disabled_at', { withTimezone: true }),
		disabledReason: text('disabled_reason'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Kept in sync with the migration's hand-written ALTER by hand, for the
		// reason audit_event_actor_type_check records: Drizzle regenerates check
		// constraints rather than altering them.
		check('event_endpoint_format_check', sql`${table.format} IN ('generic', 'teams')`),
		// "Disabled" is ONE state, not two columns that usually agree. A manual
		// disable and an auto-disable both carry a reason, so the UI never shows a
		// disabled endpoint with nothing to say about why.
		check(
			'event_endpoint_disabled_check',
			sql`(${table.enabled} = false) = (${table.disabledAt} IS NOT NULL)`
		)
	]
);

/**
 * An exact action name (`access_request.approved`) or one trailing wildcard
 * segment (`access_request.*`). Deliberately not a glob, for the reason
 * `access_rule.pattern` gives for the same restriction: a general pattern
 * engine invites expressions nobody can reason about, and this one is
 * evaluated at the moment an event carrying a prospect's name leaves the
 * building.
 *
 * An endpoint with no rows here receives nothing. Silence is the safe reading
 * of an empty set.
 */
export const eventEndpointFilter = pgTable(
	'event_endpoint_filter',
	{
		endpointId: uuid('endpoint_id')
			.notNull()
			.references(() => eventEndpoint.id, { onDelete: 'cascade' }),
		pattern: text('pattern').notNull()
	},
	(table) => [primaryKey({ columns: [table.endpointId, table.pattern] })]
);

/**
 * A reference to an audit event, never a rendered body. That is the whole of
 * this subsystem's erasure story and the reason it is structural rather than
 * maintained: had we enriched at fan-out time, `outbound_email`'s purge path
 * would become the first of two rather than the only one — and a second one is
 * the kind that rots silently when somebody adds a field (spec §2.3).
 */
export const eventDelivery = pgTable(
	'event_delivery',
	{
		// Handed to the consumer as the idempotency key: because retries
		// re-render from live state, a consumer cannot deduplicate on a body
		// hash (spec §7.2).
		id: uuid('id').primaryKey().defaultRandom(),
		endpointId: uuid('endpoint_id')
			.notNull()
			.references(() => eventEndpoint.id, { onDelete: 'cascade' }),
		auditSeq: bigint('audit_seq', { mode: 'bigint' }).notNull(),
		// Travels in the payload so a gap is detectable by the consumer.
		auditId: uuid('audit_id').notNull(),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastStatusCode: integer('last_status_code'),
		// One of DELIVERY_ERROR_REASONS. Never bytes the receiver chose.
		lastError: text('last_error'),
		deliveredAt: timestamp('delivered_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// What makes a replayed fan-out a no-op, so a crash between the fan-out
		// insert and the cursor update is safe — and what absorbs the re-scan
		// purgeRequester's UPDATE of audit_event causes (plan C1).
		unique('event_delivery_endpoint_seq_key').on(table.endpointId, table.auditSeq),
		// The claim predicate. Partial, the same shape and the same reason as
		// outbound_email_claim_idx: the index stays small as delivered rows
		// accumulate.
		index('event_delivery_claim_idx')
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'pending'`),
		// Pending depth per endpoint, for backpressure and the admin list.
		index('event_delivery_endpoint_idx')
			.on(table.endpointId, table.status)
			.where(sql`${table.status} = 'pending'`),
		// The newest delivery per endpoint: the admin pages' `DISTINCT ON` and the
		// staleness check's scalar subquery. NOT partial, unlike the two above —
		// what those exclude is exactly what this reads, so without it the last
		// outcome is a scan and sort of every retained row for the endpoint, on
		// every render of a page whose seven form actions each re-run `load`.
		index('event_delivery_outcome_idx').on(
			table.endpointId,
			table.createdAt.desc(),
			table.id.desc()
		),
		check(
			'event_delivery_status_check',
			sql`${table.status} IN ('pending', 'delivered', 'failed', 'skipped')`
		)
	]
);
