import type { Attributes } from '@opentelemetry/api';

/**
 * Deliberately does not take the URL, and must not grow a parameter that
 * carries one. This application's query strings hold credentials — the magic
 * link at `/{locale}/access/verify?token=`, and the subscription management
 * link — so `url.full` and `url.query` are banned outright rather than
 * sanitised (spec §8, C6). Keeping the URL out of the signature makes the leak
 * unrepresentable rather than merely tested for.
 */
export function requestAttributes(input: {
	method: string;
	routeId: string | null;
	status: number;
}): Attributes {
	return {
		'http.request.method': input.method,
		'http.response.status_code': input.status,
		// Omitted rather than filled with the raw path: an unmatched request is
		// how a path scanner would otherwise mint one attribute value per probe.
		...(input.routeId === null ? {} : { 'http.route': input.routeId })
	};
}

export function requestSpanName(method: string, routeId: string | null): string {
	return `${method} ${routeId ?? 'unmatched'}`;
}
