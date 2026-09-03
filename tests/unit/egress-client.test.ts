import { afterEach, describe, expect, it } from 'vitest';
import { postEvent } from '../../src/lib/server/egress/client';
import { parseAllowList, validateEndpointUrl } from '../../src/lib/server/egress/destination';
import { startWebhookServer } from '../helpers/webhook-server';

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
});

/**
 * The fixture listens on 127.0.0.1, which `classifyAddress` denies
 * unconditionally — so these tests allowlist nothing and instead point the
 * client at the loopback address through the one seam that exists for it: the
 * allowlist cannot admit loopback, so `postEvent` takes an explicit
 * `pinnedAddress` override that only tests pass. Every other property under
 * test (headers, redirect refusal, the discarded body, the timeout) is
 * unaffected by which address it is.
 */
async function serve(handler: Parameters<typeof startWebhookServer>[0]) {
	const server = await startWebhookServer(handler);
	stop = server.close;
	return server;
}

describe('postEvent', () => {
	it('POSTs the body with the given headers and reports the status', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(200).end('ok');
		});

		// The fixture binds an OS-assigned ephemeral port, and
		// `validateEndpointUrl` (Task 4, unmodified) only admits 80, 443, or a
		// port the allowlist names explicitly — so the allowlist must cover the
		// fixture's actual port, not just its address, for the URL to validate.
		const allow = parseAllowList(`127.0.0.1:${server.port}`);
		const outcome = await postEvent({
			url: validateEndpointUrl(server.url, allow),
			allow,
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{"event":"access_request.pending"}',
			contentType: 'application/json',
			headers: { 'X-Trust-Center-Event': 'access_request.pending' }
		});

		expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.method).toBe('POST');
		expect(server.requests[0]?.body).toBe('{"event":"access_request.pending"}');
		expect(server.requests[0]?.headers['x-trust-center-event']).toBe('access_request.pending');
		expect(server.requests[0]?.headers['content-type']).toBe('application/json');
		// No cookie jar, and no operator-supplied header (spec §6.2).
		expect(server.requests[0]?.headers.cookie).toBeUndefined();
	});

	it('refuses a redirect rather than following it', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
		});

		// Same fixture-port caveat as above.
		const allow = parseAllowList(`127.0.0.1:${server.port}`);
		const outcome = await postEvent({
			url: validateEndpointUrl(server.url, allow),
			allow,
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{}',
			contentType: 'application/json',
			headers: {}
		});

		expect(outcome).toMatchObject({
			kind: 'failed',
			statusCode: 302,
			reason: 'redirect_refused',
			retryable: false
		});
		expect(server.requests).toHaveLength(1);
	});

	/**
	 * Three reasons, any one sufficient (spec §6.4): a receiver that echoes its
	 * input would put requester personal data into a column purgeRequester
	 * cannot reach; a slowloris or a multi-gigabyte response defeats an
	 * `await res.text()`-then-slice bound because that buffers first; and with
	 * §11's inline test send a stored body turns an admin-triggered request
	 * into an SSRF read primitive.
	 */
	it('never returns the response body', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(200).end('x'.repeat(64 * 1024));
		});

		// Same fixture-port caveat as above.
		const allow = parseAllowList(`127.0.0.1:${server.port}`);
		const outcome = await postEvent({
			url: validateEndpointUrl(server.url, allow),
			allow,
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{}',
			contentType: 'application/json',
			headers: {}
		});

		expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });
		expect(JSON.stringify(outcome)).not.toContain('xxxx');
	});

	/**
	 * The other delivery tests above pin to `127.0.0.1`, and the fixture's own
	 * URL is also `127.0.0.1` — so those tests pass even if the `lookup` option
	 * in `postEvent` were deleted entirely, because Node's own resolution of a
	 * literal IP address is a no-op that lands on the same address anyway. That
	 * proves nothing about pinning, which is the subsystem's central security
	 * property (closing the DNS-rebinding window, spec §6.3). This test makes
	 * the hostname and the pinned address genuinely differ: `hooks.example.test`
	 * (RFC 2606, guaranteed not to resolve to anything) is what Node would try
	 * to look up, while `pinnedAddress` is the fixture's real loopback address.
	 * If `lookup` is honoured, the request reaches the fixture; if it is
	 * ignored, Node tries to resolve `hooks.example.test`, fails, and the
	 * outcome is a network failure with no request recorded. Do not "simplify"
	 * this back to `127.0.0.1` — that would silently re-vacuum the test.
	 */
	it('connects to the pinned address rather than resolving the hostname', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(200).end('ok');
		});

		const allow = parseAllowList(`hooks.example.test:${server.port}`);
		const outcome = await postEvent({
			url: validateEndpointUrl(`http://hooks.example.test:${server.port}/webhook`, allow),
			allow,
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{}',
			contentType: 'application/json',
			headers: {}
		});

		expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });
		expect(server.requests).toHaveLength(1);
	});

	it('reports a refused destination without making a request', async () => {
		const outcome = await postEvent({
			url: validateEndpointUrl('https://hooks.example.test/a'),
			allow: [],
			body: '{}',
			contentType: 'application/json',
			headers: {},
			// Resolution is stubbed to a denied address, so the guard runs where a
			// real delivery would run it: at delivery time, not only at save.
			lookup: async () => [{ address: '169.254.169.254', family: 4 }]
		});

		expect(outcome).toMatchObject({
			kind: 'failed',
			statusCode: null,
			reason: 'destination_denied',
			retryable: false
		});
	});
});
