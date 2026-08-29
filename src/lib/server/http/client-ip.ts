import type { RequestEvent } from '@sveltejs/kit';

/**
 * `getClientAddress()` throws when adapter-node cannot determine an address —
 * a misconfigured ADDRESS_HEADER is enough. An audit event with a null ip is a
 * lost attribution; a thrown one is a lost mutation, and on the public download
 * path a 500 for every visitor. `audit_event.ip` is nullable by spec §10, which
 * requires the purge to set it to NULL, so null is already a value the column
 * and every reader accept.
 */
export function clientIp(event: Pick<RequestEvent, 'getClientAddress'>): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}
