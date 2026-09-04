import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
	EgressDestinationRejected,
	resolveDestination,
	validateEndpointUrl,
	type AllowEntry,
	type LookupAll,
	type PinnedAddress
} from './destination';
import type { DeliveryErrorReason } from '../db/schema';

const EGRESS_TIMEOUT_MS = 10_000;
/** Read to a bound and discarded. Never stored, never returned. */
const MAX_RESPONSE_BYTES = 8192;
/** outbound_email's numbers verbatim (spec §5.3). */
export const MAX_ATTEMPTS = 5;
const RETRY_AFTER_CAP_SECONDS = 900;

export function backoffMinutes(attempt: number): number {
	return 2 ** (attempt - 1);
}

export function classifyResponse(
	statusCode: number,
	retryAfter: string | null
): { retryable: boolean; retryAfterSeconds: number | null } {
	if (statusCode === 429) {
		const parsed = Number(retryAfter);
		const seconds =
			retryAfter !== null && Number.isFinite(parsed) && parsed >= 0
				? Math.min(parsed, RETRY_AFTER_CAP_SECONDS)
				: null;
		return { retryable: true, retryAfterSeconds: seconds };
	}

	if (statusCode === 408 || statusCode >= 500) return { retryable: true, retryAfterSeconds: null };

	// Any other 4xx, and any 3xx, are terminal on the first attempt.
	return { retryable: false, retryAfterSeconds: null };
}

export type PostOutcome =
	| { kind: 'delivered'; statusCode: number }
	| {
			kind: 'failed';
			statusCode: number | null;
			reason: DeliveryErrorReason;
			retryable: boolean;
			retryAfterSeconds: number | null;
	  };

export interface PostInput {
	/**
	 * The stored URL, unvalidated. A `URL` object cannot be accepted here: that
	 * would mean the caller ran `validateEndpointUrl`, and a caller that can run
	 * it is a caller that can forget to (spec §6.3).
	 */
	url: string;
	/**
	 * `EVENT_EGRESS_ENABLED`. Required rather than defaulted, so a new call site
	 * has to answer the question instead of inheriting a `true` nobody chose —
	 * off means nothing leaves the container, whatever the database says.
	 */
	enabled: boolean;
	allow: readonly AllowEntry[];
	body: string;
	contentType: string;
	headers: Record<string, string>;
	/** Test seam: skips resolution when the address is already known. */
	pinnedAddress?: PinnedAddress;
	/** Test seam: the resolver `resolveDestination` uses. */
	lookup?: LookupAll;
}

function refused(reason: DeliveryErrorReason): PostOutcome {
	return { kind: 'failed', statusCode: null, reason, retryable: false, retryAfterSeconds: null };
}

/**
 * The one way out. Not a general HTTP client and not reusable as one (spec §6):
 * POST only, no redirects, no cookie jar, no operator-supplied header, a fixed
 * timeout, and the *validated* address handed to the socket through the
 * `lookup` option so the connection cannot go somewhere a second resolution
 * would return.
 *
 * The kill switch and `validateEndpointUrl` are enforced HERE rather than at
 * each caller, because a caller is exactly what can omit them: the admin test
 * send did, and reached an operator-supplied host with egress switched off.
 */
export async function postEvent(input: PostInput): Promise<PostOutcome> {
	if (!input.enabled) return refused('egress_disabled');

	// Re-validated on every attempt, not only on save: an endpoint row can be
	// changed by anyone with admin access between the two, and the allowlist can
	// change under a row that was valid when it was written. A rejection is this
	// delivery's terminal failure, never a throw — one unparseable stored URL
	// used to abandon the rest of the claimed batch and repeat every tick.
	let url: URL;
	try {
		url = validateEndpointUrl(input.url, input.allow);
	} catch (cause) {
		if (cause instanceof EgressDestinationRejected) return refused(cause.reason);
		throw cause;
	}

	let pinned: PinnedAddress;
	try {
		pinned = input.pinnedAddress ?? (await resolveDestination(url, input.allow, input.lookup));
	} catch (cause) {
		// Deliberately not `cause.reason`: what a resolution refuses is the
		// destination, whichever rule named it.
		if (cause instanceof EgressDestinationRejected) return refused('destination_denied');
		throw cause;
	}

	const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
	const payload = Buffer.from(input.body, 'utf8');

	return new Promise<PostOutcome>((resolve) => {
		const clientRequest = send({
			protocol: url.protocol,
			hostname: url.hostname,
			port: pinned.port,
			path: `${url.pathname}${url.search}`,
			method: 'POST',
			headers: {
				...input.headers,
				'content-type': input.contentType,
				'content-length': payload.byteLength
			},
			timeout: EGRESS_TIMEOUT_MS,
			// The whole point: the socket connects to the address that was
			// classified, not to whatever DNS returns a second time.
			lookup: (_hostname, options, callback) => {
				if (options && (options as { all?: boolean }).all) {
					(callback as unknown as (error: null, addresses: unknown[]) => void)(null, [
						{ address: pinned.address, family: pinned.family }
					]);
					return;
				}
				(callback as (error: null, address: string, family: number) => void)(
					null,
					pinned.address,
					pinned.family
				);
			}
		});

		let settled = false;
		const settle = (outcome: PostOutcome) => {
			if (settled) return;
			settled = true;
			clientRequest.destroy();
			resolve(outcome);
		};

		clientRequest.on('response', (response) => {
			const statusCode = response.statusCode ?? 0;

			if (statusCode >= 300 && statusCode < 400) {
				settle({
					kind: 'failed',
					statusCode,
					reason: 'redirect_refused',
					retryable: false,
					retryAfterSeconds: null
				});
				return;
			}

			// Counted and dropped as it arrives. `await res.text()` then slice
			// buffers first, which is what a multi-gigabyte response exploits.
			let seen = 0;
			response.on('data', (chunk: Buffer) => {
				seen += chunk.byteLength;
				if (seen > MAX_RESPONSE_BYTES) response.destroy();
			});

			const finish = () => {
				if (statusCode >= 200 && statusCode < 300) {
					settle({ kind: 'delivered', statusCode });
					return;
				}

				const classification = classifyResponse(
					statusCode,
					(response.headers['retry-after'] as string | null | undefined) ?? null
				);
				settle({
					kind: 'failed',
					statusCode,
					reason: 'http_status',
					retryable: classification.retryable,
					retryAfterSeconds: classification.retryAfterSeconds
				});
			};

			response.on('end', finish);
			// destroy() after the bound is hit ends the stream without 'end'.
			response.on('close', finish);
		});

		clientRequest.on('timeout', () => {
			settle({
				kind: 'failed',
				statusCode: null,
				reason: 'timeout',
				retryable: true,
				retryAfterSeconds: null
			});
		});

		clientRequest.on('error', () => {
			settle({
				kind: 'failed',
				statusCode: null,
				reason: 'network',
				retryable: true,
				retryAfterSeconds: null
			});
		});

		clientRequest.end(payload);
	});
}
