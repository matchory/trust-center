/**
 * Adaptive Card `TextBlock` renders markdown. Part of the data reaching a
 * formatter is supplied by whoever filled in a public form, so a company name
 * of `[Password reset required](https://evil.example)` would become a
 * clickable link in the security team's own channel, delivered by the trust
 * center (spec §3.3).
 *
 * The backslash is escaped first — otherwise escaping `[` into `\[` and then
 * escaping backslashes would double the escape and render the marker.
 */
export function escapeMarkdown(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/[[\]()*_`~#>|-]/g, (match) => `\\${match}`);
}
