import { formatGeneric } from './generic';
import { formatTeams } from './teams';
import type { EgressFormat } from '../../db/schema';
import type { EventModel } from '../model';

export { escapeMarkdown } from './escape';

export type Formatter = (model: EventModel) => { body: string; contentType: string };

/**
 * Adding Slack later is: one file, one entry here, one value in
 * `event_endpoint_format_check`, and unit tests. That is the point of the
 * registry and the reason `format` is a column rather than two branches
 * (spec §3.3).
 */
export const FORMATTERS: Record<EgressFormat, Formatter> = {
	generic: formatGeneric,
	teams: formatTeams
};

export function formatEvent(
	format: EgressFormat,
	model: EventModel
): { body: string; contentType: string } {
	return FORMATTERS[format](model);
}
