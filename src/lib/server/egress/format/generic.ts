import type { EventModel } from '../model';

/**
 * The model rendered directly, in snake_case because that is what a JSON
 * consumer expects and this is the shape n8n reads. `seq` stays a string: it
 * is a bigint, and a consumer parsing it as a JSON number silently loses
 * precision above 2^53 — which matters because `seq` is what makes a gap
 * detectable (spec §4.4).
 */
export function formatGeneric(model: EventModel): { body: string; contentType: string } {
	return {
		contentType: 'application/json',
		body: JSON.stringify({
			event: model.action,
			at: model.at.toISOString(),
			event_id: model.eventId,
			seq: model.seq,
			delivery_id: model.deliveryId,
			verified: model.verified,
			subject: model.subject,
			actor: model.actor,
			summary: model.summary,
			link: model.link,
			data: model.data
		})
	};
}
