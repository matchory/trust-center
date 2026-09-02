import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import {
	saveSubscription,
	subscriptionByManageToken,
	unsubscribe
} from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders, url }) => {
	// The manage token never expires, so a cached copy of this page is a
	// permanent credential sitting in a shared cache (spec §10.3, P4.21).
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });

	const token = url.searchParams.get('token') ?? '';
	const found = await subscriptionByManageToken(getDb(), token);
	// 404 rather than a message: an unknown token is indistinguishable from a
	// path that does not exist, and should look like one.
	if (!found) error(404, 'Not found');

	return {
		token,
		topics: found.topics,
		subscriptionLocale: found.locale,
		allTopics: [...UPDATE_KINDS],
		availableLocales: [...getConfig().locales]
	};
};

const saveSchema = z.object({
	// Same rule as the subscribe form (spec §5). Saving zero topics is NOT
	// quietly an unsubscribe: that button is right there, and a save that
	// silently deleted the record being edited would be a destructive action
	// behind a non-destructive control.
	topics: z.array(z.enum(UPDATE_KINDS)).min(1),
	locale: z.string()
});

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData();
		const found = await subscriptionByManageToken(getDb(), String(form.get('token') ?? ''));
		if (!found) error(404, 'Not found');

		const parsed = saveSchema.safeParse({
			topics: form.getAll('topics').map(String),
			locale: form.get('locale')
		});
		if (!parsed.success) return fail(400, { field: 'topics' });

		// A locale the operator has since disabled must not be storable, or the
		// notice job would have to fall back on every send (spec §6.4).
		const config = getConfig();
		const locale = config.locales.includes(parsed.data.locale)
			? parsed.data.locale
			: config.defaultLocale;

		await saveSubscription(getDb(), found.id, { locale, topics: parsed.data.topics });

		await recordEvent(getDb(), {
			actor: { type: 'subscriber', id: found.id },
			action: 'subscription.topics_changed',
			subjectType: 'subscription',
			subjectId: found.id,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined,
			meta: { topicCount: parsed.data.topics.length, locale }
		});

		// The path prefix names the locale being left, so a locale change has to
		// land on the new one — otherwise the page redraws in the old language
		// and reads as a save that did not take.
		redirect(
			303,
			localizePath(`/subscribe/manage?token=${encodeURIComponent(found.manageToken)}`, locale)
		);
	},

	unsubscribe: async (event) => {
		const form = await event.request.formData();
		const found = await subscriptionByManageToken(getDb(), String(form.get('token') ?? ''));
		if (!found) error(404, 'Not found');

		await unsubscribe(getDb(), found.id);

		await recordEvent(getDb(), {
			// Written after the delete. The audit row's actor_id now points at a
			// row that is gone, and that is the design (spec §10.2): the link
			// between occurrence and person is broken while the occurrence
			// survives. We do NOT additionally clear actor_id — the triggers
			// would permit it, but it would destroy an auditor's ability to read
			// "confirmed on the 3rd, left on the 20th" as one story, for no
			// privacy gain now that the UUID points at nothing.
			actor: { type: 'subscriber', id: found.id },
			action: 'subscription.unsubscribed',
			subjectType: 'subscription',
			subjectId: found.id,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined
		});

		return { gone: true };
	}
};
