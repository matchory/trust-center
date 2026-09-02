import { fail } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { confirmSubscription } from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

/**
 * The load deliberately does not look the token up, and above all does not
 * consume it. Corporate mail scanners and link previewers prefetch URLs in
 * inbound mail; a confirming GET would let a scanner forge the exact consent
 * that double opt-in exists to evidence (P4.3). The page renders a button and a
 * human presses it.
 */
export const load: PageServerLoad = async ({ setHeaders, url }) => {
	// Not cacheable, unlike every other portal page: the query string carries a
	// token, and a shared cache serving this page to the next visitor would hand
	// it over (spec §10.3). `no-referrer` keeps it out of a Referer header.
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const token = String(form.get('token') ?? '');

		const confirmed = await confirmSubscription(getDb(), token);
		// Unknown, spent and expired are one outcome on purpose: the page cannot
		// tell them apart and telling a caller which would be a probing oracle.
		if (!confirmed) return fail(410, { expired: true });

		await recordEvent(getDb(), {
			// The fourth actor (P4.11). `system` would make "who consented"
			// unanswerable in precisely the case where consent is the fact being
			// evidenced. The id is the subscription UUID; the address is nowhere.
			actor: { type: 'subscriber', id: confirmed.subscriptionId },
			action: 'subscription.confirmed',
			subjectType: 'subscription',
			subjectId: confirmed.subscriptionId,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined
		});

		return { confirmed: true };
	}
};
