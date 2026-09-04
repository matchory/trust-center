import { formatGeneric } from './generic';
import { formatTeams } from './teams';
import type { EgressFormat } from '../../db/schema';
import type { EventModel } from '../model';

export { escapeMarkdown } from './escape';

export type Formatter = (model: EventModel) => { body: string; contentType: string };

interface FormatSpec {
	render: Formatter;
	/**
	 * Whether a consumer of this format authenticates the payload, and therefore
	 * whether EVENT_SIGNING_KEY must be configured before an endpoint may use it.
	 *
	 * A property of the format rather than a `=== 'generic'` test at each of the
	 * three enforcement points, because those tests are what would silently
	 * *not* apply to a format added later: Slack verifies signatures, so a
	 * `slack` entry guarded by `=== 'generic'` would save with no key, deliver
	 * unsigned, and test-send unsigned, with nothing failing loudly (spec §7.1).
	 */
	signed: boolean;
}

/**
 * Adding Slack later is: one file, one entry here, one value in
 * `event_endpoint_format_check`, and unit tests. That is the point of the
 * registry and the reason `format` is a column rather than two branches
 * (spec §3.3).
 */
const FORMATTERS: Record<EgressFormat, FormatSpec> = {
	generic: { render: formatGeneric, signed: true },
	// Teams verifies nothing, so a Teams-only operator should not have to manage
	// a key they cannot use.
	teams: { render: formatTeams, signed: false }
};

export function formatEvent(
	format: EgressFormat,
	model: EventModel
): { body: string; contentType: string } {
	return FORMATTERS[format].render(model);
}

/** True when this format's consumer authenticates the payload. */
export function requiresSigning(format: EgressFormat): boolean {
	return FORMATTERS[format].signed;
}
