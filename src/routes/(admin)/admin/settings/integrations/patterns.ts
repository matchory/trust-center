/**
 * One pattern per line, which is how the textarea presents them. Commas are
 * accepted too because an operator pasting `EVENT_EGRESS_ALLOW`-shaped text is
 * the likelier mistake than one meaning a comma inside a pattern — the shape
 * `isValidPattern` permits has no comma in it, so nothing is lost.
 *
 * Its own module rather than a helper in one route: both routes parse the same
 * field, and a second copy is how the two come to disagree.
 */
export function parsePatterns(raw: FormDataEntryValue | null): string[] {
	return String(raw ?? '')
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0);
}
