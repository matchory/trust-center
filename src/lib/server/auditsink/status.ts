import { sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { SINK_NAMES } from '../db/schema';
import { lastAttestedAt } from './attest';
import { createS3Adapter } from './s3';
import { createSyslogAdapter } from './syslog';
import { pendingShipments } from './ship';
import type { AuditSinkAdapter, ObjectLockStatus } from './port';
import type { SinkName } from '../db/schema';
import type { Db } from '../db';

export interface SinkStatus {
	name: SinkName;
	configured: boolean;
	pending: number;
	oldestPendingAt: Date | null;
	lastShippedAt: Date | null;
	lastError: { reason: string; statusCode: number | null } | null;
	digestMismatches: number;
	/** Null when the transport has no such notion, or is not configured. */
	objectLock: ObjectLockStatus | null;
}

/**
 * Deliberately **not** "rows not yet batched" evaluated from the keyset. That
 * figure would be an unindexable sequential scan on every render — `xmin` is a
 * system column — and it would read zero in exactly the two cases that matter:
 * a forged cursor (§2.1) and a period when the sink was off (§3.4). Comparing
 * the log's own height against what the batches recorded detects both.
 */
export interface SinkCoverage {
	eventCount: number;
	eventMaxSeq: string;
	batchCount: number;
	batchedMaxSeq: string;
	lastBatchAt: Date | null;
	lastAttestedAt: Date | null;
}

/**
 * Six hours. §3.1 puts the sink's latency budget at minutes to hours, so a
 * batch still waiting after six is not a quiet deployment — it is a stuck one.
 * Deliberately far above the 15-minute default batch age, so the ordinary
 * rhythm never raises it.
 */
export const BACKLOG_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export interface AuditSinkStatus {
	enabled: boolean;
	sinks: SinkStatus[];
	coverage: SinkCoverage;
}

function adapterFor(sink: SinkName): AuditSinkAdapter | null {
	const { auditSink } = getConfig();

	if (sink === 's3') return auditSink.s3 ? createS3Adapter(auditSink.s3) : null;

	// hostname is the RFC 5424 HOSTNAME field, derived from BASE_URL rather
	// than an operator setting (decision D2) — it is not part of the config
	// schema, so it is added here rather than carried on auditSink.syslog.
	if (!auditSink.syslog) return null;
	const hostname = new URL(getConfig().baseUrl).host;

	return createSyslogAdapter({ ...auditSink.syslog, hostname });
}

/**
 * The most recent failure a sink is still carrying. Scoped to unshipped rows:
 * an error on a row that later shipped is history, and showing it would have
 * the panel report a healthy sink as failing forever.
 */
async function lastErrors(
	db: Db
): Promise<Map<string, { reason: string; statusCode: number | null }>> {
	const rows = (await db.execute(sql`
		SELECT DISTINCT ON (sink) sink, last_error, last_status_code
		FROM audit_batch_shipment
		WHERE shipped_at IS NULL AND last_error IS NOT NULL
		ORDER BY sink, next_attempt_at DESC
	`)) as unknown as { sink: string; last_error: string; last_status_code: number | null }[];

	return new Map(
		rows.map((row) => [row.sink, { reason: row.last_error, statusCode: row.last_status_code }])
	);
}

/**
 * Shipments whose stored digest disagrees with the batch's — §4.3's detected
 * erasures, counted from the rows rather than from the metric so the panel
 * still reports them on a deployment with no collector, which is most of them
 * (§9).
 */
async function shipmentFacts(
	db: Db
): Promise<Map<string, { lastShippedAt: Date | null; digestMismatches: number }>> {
	const rows = (await db.execute(sql`
		SELECT sh.sink,
		       max(sh.shipped_at) AS last_shipped_at,
		       count(*) FILTER (WHERE sh.digest IS NOT NULL AND sh.digest <> b.digest)::int
		         AS digest_mismatches
		FROM audit_batch_shipment sh
		JOIN audit_batch b ON b.id = sh.batch_id
		GROUP BY sh.sink
	`)) as unknown as {
		sink: string;
		last_shipped_at: Date | string | null;
		digest_mismatches: number;
	}[];

	return new Map(
		rows.map((row) => [
			row.sink,
			{
				lastShippedAt: row.last_shipped_at ? new Date(row.last_shipped_at) : null,
				digestMismatches: row.digest_mismatches
			}
		])
	);
}

async function coverage(db: Db): Promise<SinkCoverage> {
	const [events, batches, attested] = await Promise.all([
		db.execute(sql`
			SELECT count(*)::int AS count, coalesce(max(seq), 0)::text AS max_seq
			FROM audit_event
		`) as unknown as Promise<{ count: number; max_seq: string }[]>,
		db.execute(sql`
			SELECT count(*)::int AS count,
			       coalesce(max(max_seq), 0)::text AS max_seq,
			       max(created_at) AS last_at
			FROM audit_batch
		`) as unknown as Promise<{ count: number; max_seq: string; last_at: Date | string | null }[]>,
		lastAttestedAt(db)
	]);

	return {
		eventCount: events[0]?.count ?? 0,
		eventMaxSeq: events[0]?.max_seq ?? '0',
		batchCount: batches[0]?.count ?? 0,
		batchedMaxSeq: batches[0]?.max_seq ?? '0',
		lastBatchAt: batches[0]?.last_at ? new Date(batches[0].last_at) : null,
		lastAttestedAt: attested
	};
}

/**
 * The badge's question alone, for the admin navigation: is any configured sink
 * carrying a batch older than the threshold?
 *
 * Separate from `auditSinkStatus` because it runs on **every** admin page
 * render, so it must stay one indexed query and must never reach the network —
 * no object-lock probe, no per-sink facts. It exists because on a default
 * deployment there is no metrics collector at all (§9), which would otherwise
 * leave "the compliance record silently stopped leaving the box" visible only
 * to an operator who opens one particular page.
 */
export async function auditSinkBacklog(db: Db): Promise<{ oldestAt: Date } | null> {
	const { auditSink } = getConfig();
	if (!auditSink.enabled) return null;

	const configured = SINK_NAMES.filter((sink) => adapterFor(sink) !== null);
	if (configured.length === 0) return null;

	const pending = await Promise.all(configured.map((sink) => pendingShipments(db, sink)));
	const oldest = pending
		.map((row) => row.oldestAt)
		.filter((at): at is Date => at !== null)
		.sort((a, b) => a.getTime() - b.getTime())[0];

	if (!oldest || Date.now() - oldest.getTime() < BACKLOG_THRESHOLD_MS) return null;

	return { oldestAt: oldest };
}

/**
 * Everything §10's read-only panel shows, in one call. Read concurrently, the
 * shape `listEndpoints` uses for the same reason: these are independent
 * queries and a page render should cost one round trip, not six.
 *
 * The object-lock probe is the one part that can reach the network, and it is
 * memoised per process inside the adapter — a render is not an S3 round trip
 * after the first.
 */
export async function auditSinkStatus(db: Db): Promise<AuditSinkStatus> {
	const { auditSink } = getConfig();
	const adapters = new Map(SINK_NAMES.map((sink) => [sink, adapterFor(sink)]));

	const [pending, facts, errors, cover, locks] = await Promise.all([
		Promise.all(SINK_NAMES.map((sink) => pendingShipments(db, sink))),
		shipmentFacts(db),
		lastErrors(db),
		coverage(db),
		Promise.all(
			SINK_NAMES.map(async (sink) => {
				const adapter = adapters.get(sink);

				return adapter?.objectLock ? await adapter.objectLock() : null;
			})
		)
	]);

	return {
		enabled: auditSink.enabled,
		coverage: cover,
		sinks: SINK_NAMES.map((sink, index) => ({
			name: sink,
			configured: adapters.get(sink) !== null,
			pending: pending[index]!.count,
			oldestPendingAt: pending[index]!.oldestAt,
			lastShippedAt: facts.get(sink)?.lastShippedAt ?? null,
			lastError: errors.get(sink) ?? null,
			digestMismatches: facts.get(sink)?.digestMismatches ?? 0,
			objectLock: locks[index] ?? null
		}))
	};
}
