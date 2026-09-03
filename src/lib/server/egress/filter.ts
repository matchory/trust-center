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
