import { redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { verifyRequest } from '$lib/server/access/verify';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import {
	createRequesterSession,
	REQUESTER_SESSION_COOKIE,
	requesterCookieOptions
} from '$lib/server/identity/requester';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import type { Actions, PageServerLoad } from './$types';

/**
 * GET only renders a confirmation page. Consuming the token here would let a
 * mail gateway's link scanner burn a single-use link before the person ever
 * sees it (spec §9.2).
 */
export const load: PageServerLoad = async ({ url }) => {
	// `no-store` comes from the subtree's layout, which owns it for everything
	// under /access. Setting it here too makes SvelteKit throw: the same header
	// may not be set twice for one response.
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const token = String(form.get('token') ?? '');
		const db = getDb();
		const config = getConfig();
		const ip = clientIp(event);

		// A missing client address falls back to a shared bucket rather than
		// skipping the check — the same choice the request form makes.
		const limited = await consumeRateLimit(db, {
			key: rateLimitKey('verify:ip', ip ?? 'unknown'),
			limit: 20,
			windowSeconds: 3600
		});
		if (!limited.allowed) return { failed: true };

		const outcome = await verifyRequest(db, {
			token,
			ip,
			ua: event.request.headers.get('user-agent'),
			locale: event.locals.locale,
			grantTtlDays: config.accessGrantDefaultDays,
			staffNotification: config.mail.staffNotificationEmail
				? {
						to: config.mail.staffNotificationEmail,
						locale: config.defaultLocale,
						baseUrl: config.baseUrl
					}
				: null
		});

		// A spent, expired, or unknown token all end here, saying the same thing.
		if (!outcome.ok) return { failed: true };

		const { token: sessionToken, expiresAt } = await createRequesterSession(db, {
			requesterId: outcome.requesterId,
			ttlHours: config.requesterSessionTtlHours,
			ip,
			ua: event.request.headers.get('user-agent')
		});

		event.cookies.set(REQUESTER_SESSION_COOKIE, sessionToken, {
			...requesterCookieOptions(event.locals.locale),
			expires: expiresAt
		});

		redirect(303, localizePath('/access', event.locals.locale));
	}
};
