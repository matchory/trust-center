import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
	EgressDestinationRejected,
	resolveDestination,
	type AllowEntry,
	type LookupAll,
	type PinnedAddress
} from './destination';
import type { DeliveryErrorReason } from '../db/schema';

export const EGRESS_TIMEOUT_MS = 10_000;
/** Read to a bound and discarded. Never stored, never returned. */
export const MAX_RESPONSE_BYTES = 8192;
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
	url: URL;
	allow: readonly AllowEntry[];
	body: string;
	contentType: string;
	headers: Record<string, string>;
	/** Test seam: skips resolution when the address is already known. */
	pinnedAddress?: PinnedAddress;
	/** Test seam: the resolver `resolveDestination` uses. */
	lookup?: LookupAll;
}

/**
 * The one way out. Not a general HTTP client and not reusable as one (spec §6):
 * POST only, no redirects, no cookie jar, no operator-supplied header, a fixed
 * timeout, and the *validated* address handed to the socket through the
 * `lookup` option so the connection cannot go somewhere a second resolution
 * would return.
 */
export async function postEvent(input: PostInput): Promise<PostOutcome> {
	let pinned: PinnedAddress;
	try {
		pinned =
			input.pinnedAddress ?? (await resolveDestination(input.url, input.allow, input.lookup));
	} catch (cause) {
		if (cause instanceof EgressDestinationRejected) {
			return {
				kind: 'failed',
				statusCode: null,
				reason: 'destination_denied',
				retryable: false,
				retryAfterSeconds: null
			};
		}
		throw cause;
	}

	const send = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
	const payload = Buffer.from(input.body, 'utf8');

	return new Promise<PostOutcome>((resolve) => {
		const clientRequest = send({
			protocol: input.url.protocol,
			hostname: input.url.hostname,
			port: pinned.port,
			path: `${input.url.pathname}${input.url.search}`,
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
