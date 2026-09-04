import type { BatchManifest } from './serialize';
import type { ShipmentErrorReason, SinkName } from '../db/schema';

export interface SinkBatch {
	id: string;
	body: Uint8Array<ArrayBuffer>;
	digest: string;
	manifest: BatchManifest;
}

/**
 * `none` means our objects get no retention — a bucket with lock disabled and a
 * bucket with lock enabled but no default rule are the same fact from here,
 * because the adapter sends no per-object retention (spec §5.2). `unknown` is
 * what an absent permission looks like: we cannot prove the bucket is locked,
 * and saying so is the point (spec §5.2).
 */
export type ObjectLockStatus = 'compliance' | 'governance' | 'none' | 'unknown';

export interface Attestation {
	at: string;
	event_count: string;
	max_seq: string;
	cursor: { xmin: string; seq: string };
	last_batch_id: string | null;
	batches_since: number;
}

/**
 * An adapter receives bytes and a manifest. It never receives rows, a database
 * handle, or another sink's configuration — that isolation is the reason the
 * port exists, and it is what keeps one sink's failure off another (spec §5.1).
 */
export interface AuditSinkAdapter {
	readonly name: SinkName;
	/**
	 * Returns the object key written, for `audit_batch_shipment.object_key`, or
	 * `null` from a transport that addresses no object — a syslog receiver has
	 * nowhere to point an auditor. Null rather than the batch id, which would
	 * duplicate `batch_id` and read as a plausible key that is actually wrong.
	 */
	ship(batch: SinkBatch): Promise<string | null>;
	attest(attestation: Attestation): Promise<void>;
	/**
	 * What the receiving store does to protect what has been written, for §10's
	 * panel. Optional because it is not a property every transport has: a syslog
	 * receiver's retention is the receiver's business and nothing we can ask it.
	 */
	objectLock?(): Promise<ObjectLockStatus>;
}

/** Thrown by an adapter so the shipper records a closed-set reason rather than
 * a provider message (spec §5.4, issue #11). */
export class SinkError extends Error {
	constructor(
		readonly reason: ShipmentErrorReason,
		readonly statusCode?: number
	) {
		super(reason);
		this.name = 'SinkError';
	}
}
