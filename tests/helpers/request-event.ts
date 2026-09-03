import type { RequestEvent } from '@sveltejs/kit';

/**
 * A stand-in for SvelteKit's `RequestEvent`, for the several server modules
 * that take one and were therefore reachable only through e2e.
 *
 * `serveDocumentFile` is the case this was built for: it reads `params`,
 * `request.headers`, `locals.requester`, `locals.locale` and
 * `getClientAddress()`, and nothing else — a much smaller surface than the
 * `RequestEvent` type suggests, which is why the module looked untestable for
 * longer than it was. Everything the module does not read is left off rather
 * than faked, so a call site that starts reading something new fails loudly
 * here instead of quietly getting `undefined`.
 */
export function fakeRequestEvent<Params extends Partial<Record<string, string>>>(input: {
	params: Params;
	locals?: Partial<App.Locals>;
	headers?: Record<string, string>;
	clientAddress?: string | null;
	url?: string;
}): RequestEvent<Params> {
	const url = new URL(input.url ?? 'https://trust.example.com/');

	return {
		params: input.params,
		url,
		request: new Request(url, { headers: input.headers ?? {} }),
		locals: (input.locals ?? {}) as App.Locals,
		// `clientIp` catches the throw and falls back to null, which is the
		// behaviour a misconfigured ADDRESS_HEADER produces in production — so
		// `clientAddress: null` exercises a real path rather than an invented one.
		getClientAddress: () => {
			if (input.clientAddress === null) throw new Error('address unavailable');
			return input.clientAddress ?? '203.0.113.7';
		}
	} as unknown as RequestEvent<Params>;
}
