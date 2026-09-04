/**
 * The stable seam. Everything above it is domain code that reads the database;
 * everything below it is presentation. This is the thing this subsystem
 * promises not to break, and every wire shape is derived from it (spec §3.1).
 */
export interface EventModel {
	/** The audit action, verbatim. */
	action: string;
	at: Date;
	/** audit_event.id */
	eventId: string;
	/** audit_event.seq, as a string: a bigint does not survive JSON.stringify. */
	seq: string;
	deliveryId: string;
	subject: { type: string; id: string } | null;
	actor: { type: string; id: string | null };
	/**
	 * True when the payload's subject data was identity-verified. False on the
	 * fallback path and on `access_request.submitted`, whose data is free text
	 * from a public form (spec §4.3) — stated on the wire so a consumer
	 * branching on it does not have to know which of our action names implies
	 * verification.
	 */
	verified: boolean;
	/** Enriched from live domain state, or the audit row's meta as a fallback. */
	data: Record<string, unknown>;
	/** Human-readable one-liner. Formatters that render prose use this. */
	summary: string;
	/** Absolute URL into the admin area, where one exists for the subject. */
	link: string | null;
}
