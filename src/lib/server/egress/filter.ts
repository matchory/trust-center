import { inArray } from 'drizzle-orm';
import { eventEndpointFilter } from '../db/schema';
import type { Db } from '../db';

/** The vocabulary audit actions are drawn from: `noun.verb`, lowercase. */
const SEGMENT = '[a-z0-9_-]+';
const PATTERN = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*(\\.\\*)?$`);

/**
 * An operator subscribes by pattern rather than by picking from a list this
 * subsystem controls (spec §4.1) — an operator who wants `control.*` in a
 * channel should not have to wait for us. What is restricted is the *shape*: an
 * exact name, or one trailing wildcard segment. A leading or interior wildcard
 * is rejected for the reason access_rule.pattern rejects the same thing.
 */
export function isValidPattern(pattern: string): boolean {
	return PATTERN.test(pattern);
}

/**
 * `a.*` matches `a.b` and `a.b.c`; it does not match `a`, and it does not match
 * `ab.c`. Comparison is on segment boundaries rather than on a string prefix,
 * so `ab.c` cannot slip through the `a.` prefix test.
 */
export function matchesPattern(pattern: string, action: string): boolean {
	if (!pattern.endsWith('.*')) return pattern === action;

	const prefix = pattern.slice(0, -1); // keeps the trailing dot
	return action.startsWith(prefix) && action.length > prefix.length;
}

/**
 * The patterns of many endpoints, keyed by endpoint id.
 *
 * Both readers of `event_endpoint_filter` — the fan-out loop and the admin
 * detail page — want exactly this shape, and a second copy of the read is how
 * the two come to disagree about it. Ordered by pattern because one of them
 * renders the list; the other only calls `.some()` over it, so the order costs
 * it nothing.
 *
 * Accumulated here rather than through `groupByKey`, which groups whole rows:
 * the buckets hold the projected `pattern`, so routing through it would mean
 * building a map of rows and then rebuilding it. Same non-quadratic push its
 * docstring insists on.
 */
export async function patternsByEndpoint(
	db: Db,
	ids: readonly string[]
): Promise<Map<string, string[]>> {
	const rows = await db
		.select({ endpointId: eventEndpointFilter.endpointId, pattern: eventEndpointFilter.pattern })
		.from(eventEndpointFilter)
		.where(inArray(eventEndpointFilter.endpointId, ids))
		.orderBy(eventEndpointFilter.pattern);

	const patterns = new Map<string, string[]>();
	for (const row of rows) {
		const bucket = patterns.get(row.endpointId);
		if (bucket) bucket.push(row.pattern);
		else patterns.set(row.endpointId, [row.pattern]);
	}

	return patterns;
}
