import { describe, expect, it } from 'vitest';
import { backoffMinutes, classifyResponse, MAX_ATTEMPTS } from '../../src/lib/server/egress/client';

describe('classifyResponse', () => {
	it('retries a 5xx, a 408 and a 429', () => {
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(true);
		}
	});

	/**
	 * Retrying a 404 or a 401 five times over fifteen minutes buys nothing and
	 * delays the operator seeing a misconfiguration by a quarter of an hour
	 * (spec §5.3).
	 */
	it('is terminal on any other 4xx', () => {
		for (const status of [400, 401, 403, 404, 410, 422]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(false);
		}
	});

	// A redirect is the cheapest way to launder a denied destination into an
	// allowed one, and no legitimate webhook receiver needs one (spec §6.1).
	it('is terminal on any 3xx', () => {
		for (const status of [301, 302, 307, 308]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(false);
		}
	});

	it('honours Retry-After on a 429, capped at fifteen minutes', () => {
		expect(classifyResponse(429, '30').retryAfterSeconds).toBe(30);
		expect(classifyResponse(429, '99999').retryAfterSeconds).toBe(900);
		expect(classifyResponse(429, 'not-a-number').retryAfterSeconds).toBeNull();
	});

	/**
	 * Only on 429, where it is a rate-limit signal. On a 5xx it is a server
	 * guessing about its own recovery, and our backoff is already the right
	 * answer (spec §15).
	 */
	it('ignores Retry-After on a 5xx', () => {
		expect(classifyResponse(503, '600').retryAfterSeconds).toBeNull();
	});
});

describe('backoffMinutes', () => {
	// outbound_email's numbers verbatim, so the deployment has one retry story
	// rather than two that differ for no reason (spec §5.3).
	it('is 1, 2, 4, 8 minutes and then gives up', () => {
		expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([1, 2, 4, 8]);
		expect(MAX_ATTEMPTS).toBe(5);
	});
});
