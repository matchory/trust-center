import { and, eq, sql } from 'drizzle-orm';
import { auditBatch, auditBatchShipment } from '../db/schema';
import { AUDIT_SELECT, buildManifest, seqRange, serializeBatch } from './serialize';
import { SinkError } from './port';
import type { AuditSinkAdapter, SinkBatch } from './port';
import type { AuditRowText } from './serialize';
import type { ShipmentErrorReason, SinkName } from '../db/schema';
import type { Db } from '../db';

// Re-exported so callers of the ship loop and its tests need one import path
// for both the classifier and the error type it classifies.
export { SinkError };

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

export interface ClaimedShipment {
	batchId: string;
	sink: SinkName;
	attempts: number;
}

/** Exponential from one minute, capped at an hour, forever — there is no
 * attempt ceiling, because B may not give up (spec §2.2, §5.4). */
export function backoffMs(attempts: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/**
 * First matching rule wins (spec §5.4). A list of overlapping labels would not
 * be the lookup key docs/self-hosting.md promises: S3 answers 403 for both a
 * bad signature and a denied action, so the adapter distinguishes them and
 * this function never guesses.
 */
export function classifyError(cause: unknown): {
	reason: ShipmentErrorReason;
	statusCode?: number;
} {
	if (cause instanceof SinkError) return { reason: cause.reason, statusCode: cause.statusCode };
	if (cause instanceof DOMException && cause.name === 'AbortError') return { reason: 'timeout' };

	// fetch reports a TLS failure as a generic TypeError with the real reason in
	// the cause chain. Walking it is what makes `tls` producible at all, rather
	// than a declared reason nothing writes (cf. A §16's body_too_large).
	const code = (cause as { cause?: { code?: string } })?.cause?.code;
	if (typeof code === 'string' && /CERT|SSL|TLS|VERIFY/i.test(code)) return { reason: 'tls' };

	return { reason: 'network' };
}

/**
 * Creates the shipment rows for every configured sink over every unshipped
 * batch, then claims them — both inside the caller's transaction, which runs
 * under the advisory lock.
 *
 * Creation happens HERE and not in the shipper. Creating rows lazily on first
 * attempt would leave the first attempt at every batch unprotected by the claim
 * stamp, so two replicas with overlapping ticks would both ship it. The
 * property that mattered — a sink configured later still gets the full history
 * with no backfill command — is preserved by the INSERT … SELECT, but that
 * SELECT is itself bounded: it is restricted to batches that have no shipment
 * row yet for the sink, ordered by cursor and capped at `limit`, so a sink
 * configured against a large existing log catches up `limit` batches per tick
 * rather than scanning (and re-conflicting on) the whole table forever.
 */
export async function claimShipments(
	tx: Db,
	sinks: readonly SinkName[],
	limit: number
): Promise<ClaimedShipment[]> {
	if (sinks.length === 0) return [];

	await tx.execute(sql`
		INSERT INTO audit_batch_shipment (batch_id, sink)
		SELECT b.id, s.sink
		FROM audit_batch b
		CROSS JOIN unnest(${sql.param(sinks as string[])}::text[]) AS s(sink)
		-- Excludes the synthetic zero-row cursor re-seed batch (spec §12): without
		-- this, a re-seed after a restore would create a shipment row with
		-- nothing to ship, permanently pending in a table with no DELETE.
		WHERE b.row_count > 0
		  AND NOT EXISTS (
		    SELECT 1 FROM audit_batch_shipment sh
		    WHERE sh.batch_id = b.id AND sh.sink = s.sink
		  )
		ORDER BY b.cursor_xmin, b.cursor_seq
		LIMIT ${limit}
		ON CONFLICT (batch_id, sink) DO NOTHING
	`);

	const claimed = (await tx.execute(sql`
		UPDATE audit_batch_shipment AS s
		SET next_attempt_at = now() + interval '5 minutes'
		FROM (
			SELECT sh.batch_id, sh.sink
			FROM audit_batch_shipment sh
			JOIN audit_batch b ON b.id = sh.batch_id
			WHERE sh.shipped_at IS NULL
			  AND sh.next_attempt_at <= now()
			  AND sh.sink = ANY(${sql.param(sinks as string[])}::text[])
			ORDER BY b.cursor_xmin, b.cursor_seq
			LIMIT ${limit}
			FOR UPDATE OF sh SKIP LOCKED
		) AS due
		WHERE s.batch_id = due.batch_id AND s.sink = due.sink
		RETURNING s.batch_id, s.sink, s.attempts
	`)) as unknown as { batch_id: string; sink: SinkName; attempts: number }[];

	return claimed.map((row) => ({
		batchId: row.batch_id,
		sink: row.sink,
		attempts: Number(row.attempts)
	}));
}

/**
 * Rebuilds a batch's body from live rows over its recorded half-open range.
 *
 * A purge landing between the build and this rebuild removes its row from the
 * range entirely — purgeRequester's UPDATE bumps the row's xmin above every
 * batch cursor — so the rebuilt batch has fewer rows, not the same rows with
 * nulls. That is why the manifest, built here from what is actually sent, is
 * the authority for an object's contents (spec §4.3).
 */
export async function rebuildBatch(db: Db, batchId: string): Promise<SinkBatch> {
	const [meta] = await db.select().from(auditBatch).where(eq(auditBatch.id, batchId)).limit(1);
	if (!meta) throw new SinkError('config');

	const rows = (await db.execute(sql`
		SELECT ${sql.raw(AUDIT_SELECT)}
		FROM audit_event
		WHERE (xmin::text::bigint, seq) > (${meta.prevCursorXmin}, ${meta.prevCursorSeq})
		  AND (xmin::text::bigint, seq) <= (${meta.cursorXmin}, ${meta.cursorSeq})
		ORDER BY xmin::text::bigint, seq
	`)) as unknown as AuditRowText[];

	const { body, digest } = serializeBatch(rows);
	const { min: minSeq, max: maxSeq } = seqRange(rows);

	return {
		id: meta.id,
		body,
		digest,
		manifest: buildManifest({
			id: meta.id,
			createdAt: meta.createdAt.toISOString(),
			prevCursor: { xmin: meta.prevCursorXmin, seq: meta.prevCursorSeq },
			cursor: { xmin: meta.cursorXmin, seq: meta.cursorSeq },
			rowCount: rows.length,
			minSeq,
			maxSeq,
			byteCount: body.byteLength,
			digest
		})
	};
}

/**
 * Ships claimed batches, in cursor order within this tick, stopping a sink at
 * its first failure rather than burning the whole backlog against a dead
 * receiver. Across overlapping ticks or replicas ordering is not guaranteed and
 * the claim stamp cannot make it so (spec §5.4).
 *
 * `prebuilt` carries bodies built by phase one of this same tick, so the
 * ordinary path never rebuilds and its digest matches by construction — which
 * is what makes a recorded mismatch mean a genuine retry (spec §4.3).
 */
export async function shipClaimed(
	db: Db,
	claimed: readonly ClaimedShipment[],
	adapters: readonly AuditSinkAdapter[],
	prebuilt: ReadonlyMap<string, SinkBatch>
): Promise<void> {
	const bySink = new Map<SinkName, ClaimedShipment[]>();
	for (const shipment of claimed) {
		const list = bySink.get(shipment.sink) ?? [];
		list.push(shipment);
		bySink.set(shipment.sink, list);
	}

	await Promise.all(
		adapters.map(async (adapter) => {
			for (const shipment of bySink.get(adapter.name) ?? []) {
				try {
					// Guarded, not just adapter.ship() below: a rebuild failure — a
					// transient error on the range query, anything — is exactly as much
					// this sink's failure as a rejected upload, and must land in the same
					// catch that records the reason and backs off. Subsystem A shipped
					// this bug once already (spec §18: a stored value the allowlist no
					// longer admitted threw outside deliverClaimed's try, abandoning
					// every row claimed after it); it does not get to recur here.
					const batch =
						prebuilt.get(shipment.batchId) ?? (await rebuildBatch(db, shipment.batchId));
					await adapter.ship(batch);

					await db
						.update(auditBatchShipment)
						.set({
							shippedAt: new Date(),
							digest: batch.digest,
							attempts: shipment.attempts + 1,
							lastError: null,
							lastStatusCode: null,
							// object_key documents the S3 key written, and ship() returns
							// void so it cannot report one here. Left null rather than
							// filled with batch.id (which duplicates batch_id and would
							// read as a plausible key that is actually wrong) — the S3
							// adapter populates it once the port can report a real key.
							objectKey: null
						})
						.where(
							and(
								eq(auditBatchShipment.batchId, shipment.batchId),
								eq(auditBatchShipment.sink, adapter.name)
							)
						);
				} catch (cause) {
					const { reason, statusCode } = classifyError(cause);
					const attempts = shipment.attempts + 1;

					await db
						.update(auditBatchShipment)
						.set({
							attempts,
							lastError: reason,
							lastStatusCode: statusCode ?? null,
							nextAttemptAt: new Date(Date.now() + backoffMs(attempts))
						})
						.where(
							and(
								eq(auditBatchShipment.batchId, shipment.batchId),
								eq(auditBatchShipment.sink, adapter.name)
							)
						);

					// Stop this sink for the tick; the others keep going.
					return;
				}
			}
		})
	);
}
