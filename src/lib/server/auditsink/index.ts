import { getConfig } from '../config';
import { withSpan } from '../telemetry';
import { attestationDue, buildAttestation, markAttested } from './attest';
import { buildBatch } from './reader';
import { createS3Adapter } from './s3';
import { createSyslogAdapter } from './syslog';
import { claimShipments, shipClaimed } from './ship';
import type { Attestation, AuditSinkAdapter, SinkBatch } from './port';
import type { ClaimedShipment } from './ship';
import type { SinkName } from '../db/schema';
import type { Db } from '../db';

/** Batches claimed per tick, matching the egress claim limit. */
const CLAIM_LIMIT = 25;

/**
 * Phase one's output, handed to phase two of the same tick. Module-scoped for
 * the reason `egress/index.ts` gives: one job needs it, and a generic payload
 * channel on every `Job` is surface with nothing to buy. Safe because the two
 * phases of one tick never overlap — `runJob`'s advisory lock makes a second
 * tick skip rather than queue, and `startJobRunner` only calls phase two on the
 * tick that actually held it.
 *
 * Carrying the body here is what keeps the ordinary path from rebuilding, so a
 * recorded digest mismatch means a genuine retry rather than every batch
 * (spec §4.3).
 */
let claimed: ClaimedShipment[] = [];
let prebuilt = new Map<string, SinkBatch>();
let pendingAttestation: Attestation | null = null;

function adapters(): AuditSinkAdapter[] {
	const { auditSink, baseUrl } = getConfig();
	const active: AuditSinkAdapter[] = [];

	if (auditSink.s3) active.push(createS3Adapter(auditSink.s3));
	// hostname is the RFC 5424 HOSTNAME field, derived from BASE_URL rather
	// than an operator setting (decision D2) — it is not part of the config
	// schema, so it is added here rather than carried on auditSink.syslog.
	if (auditSink.syslog) {
		active.push(createSyslogAdapter({ ...auditSink.syslog, hostname: new URL(baseUrl).host }));
	}

	return active;
}

function reset(): void {
	claimed = [];
	prebuilt = new Map();
	pendingAttestation = null;
}

/**
 * Phase one: under the advisory lock. Reads a batch, claims shipments, and
 * builds the attestation payload when one is due — every part of it a database
 * read, and nothing that touches the network.
 *
 * Returns early while the sink is disabled, and nothing is lost by that:
 * `audit_event` is never swept on account of the sink, and the cursor's `(0,0)`
 * default means enabling it later ships the whole history from the beginning
 * (spec §11).
 */
export async function runAuditSinkBatch(db: Db): Promise<void> {
	reset();

	const { auditSink } = getConfig();
	if (!auditSink.enabled) return;

	const sinks = adapters().map((adapter): SinkName => adapter.name);
	if (sinks.length === 0) return;

	const batch = await buildBatch(db, {
		batchRows: auditSink.batchRows,
		maxAgeMs: auditSink.maxAgeMs,
		maxBytes: auditSink.maxBytes
	});
	if (batch) prebuilt.set(batch.id, batch);

	claimed = await claimShipments(db, sinks, CLAIM_LIMIT);

	// Built here, written by phase two: writing is network I/O and this runs
	// inside the advisory lock, which must not be held across the network
	// (spec §3.1).
	if (await attestationDue(db, auditSink.attestIntervalMs)) {
		pendingAttestation = await buildAttestation(db);
	}
}

/**
 * Phase two: outside the lock, on a pooled connection. Everything here talks to
 * a sink.
 *
 * The enabled check is phase one's alone — this phase acts only on what phase
 * one produced, and phase one produces nothing while the sink is off.
 */
export async function runAuditSinkShip(db: Db): Promise<void> {
	const active = adapters();
	if (active.length === 0) return reset();

	if (claimed.length > 0) {
		await withSpan('audit sink ship', { 'auditsink.batches': claimed.length }, () =>
			shipClaimed(db, claimed, active, prebuilt)
		);
	}

	if (pendingAttestation) {
		const attestation = pendingAttestation;

		// Swallowed per sink: an attestation that fails to land is recorded
		// nowhere and retried on the next interval, and one dead sink must not
		// stop another from being attested. The stamp advances either way, so a
		// permanently failing sink does not accumulate a backlog of attestations
		// (spec §8).
		await Promise.all(active.map((adapter) => adapter.attest(attestation).catch(() => undefined)));
		await markAttested(db, new Date(attestation.at));
	}

	reset();
}
