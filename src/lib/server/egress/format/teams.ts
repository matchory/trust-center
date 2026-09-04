import { escapeMarkdown } from './escape';
import type { EventModel } from '../model';

/** Flattens one `data` value into a single card line. */
function factValue(value: unknown): string {
	if (value === null || value === undefined) return '—';
	if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * An Adaptive Card in the envelope the Workflows (Power Automate) trigger
 * expects. Microsoft retired Office 365 Connectors in Teams, so `MessageCard`
 * is not the target and must not be written.
 *
 * The declared version is 1.4 rather than the newest available: Adaptive Card
 * support differs by Teams surface and client, and a card that fails to render
 * is indistinguishable to the operator from a delivery that never arrived —
 * the worst possible failure for a notification channel. 1.4 renders
 * everywhere Workflows posts (spec §3.3).
 *
 * No images and no external references: nothing in a Teams channel should
 * fetch from us.
 */
export function formatTeams(model: EventModel): { body: string; contentType: string } {
	const facts = Object.entries(model.data).map(([title, value]) => ({
		title: escapeMarkdown(title),
		value: escapeMarkdown(factValue(value))
	}));

	const card: Record<string, unknown> = {
		type: 'AdaptiveCard',
		$schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
		version: '1.4',
		body: [
			{ type: 'TextBlock', text: escapeMarkdown(model.summary), wrap: true, weight: 'Bolder' },
			{
				type: 'TextBlock',
				text: escapeMarkdown(model.action),
				wrap: true,
				isSubtle: true,
				spacing: 'None'
			},
			{ type: 'FactSet', facts }
		]
	};

	if (model.link !== null) {
		// A URL, not a rendered string, so it is NOT markdown-escaped — an
		// escaped URL is a broken button. It is our own absolute admin link,
		// built by the enricher from baseUrl, never operator or requester input.
		card.actions = [{ type: 'Action.OpenUrl', title: 'Open in trust center', url: model.link }];
	}

	return {
		contentType: 'application/json',
		body: JSON.stringify({
			type: 'message',
			attachments: [
				{
					contentType: 'application/vnd.microsoft.card.adaptive',
					contentUrl: null,
					content: card
				}
			]
		})
	};
}
