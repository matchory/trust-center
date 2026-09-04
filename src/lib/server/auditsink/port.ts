import type { BatchManifest } from './serialize';
import type { ShipmentErrorReason, SinkName } from '../db/schema';

export interface SinkBatch {
	id: string;
	body: Uint8Array<ArrayBuffer>;
	digest: string;
	manifest: BatchManifest;
}

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
