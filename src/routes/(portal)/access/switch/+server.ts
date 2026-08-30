import { error, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import {
	REQUESTER_SESSION_COOKIE,
	requesterCookieOptions,
	validateRequesterSession
} from '$lib/server/identity/requester';
import type { RequestHandler } from './$types';

/**
 * Carries a requester's session across a locale switch.
 *
 * The session cookie is scoped to `/{locale}/access`, which is what keeps the
 * public portal cookie-free — and it means `/de/access` and `/en/access` cannot
 * share one cookie, since they have no common prefix but `/`. Following the
 * locale switcher straight to `/en/access` therefore arrived anonymous and
 * dropped the requester on the request form, still holding a live grant.
 *
 * This endpoint is reached under the *current* locale, so the browser does send
 * the cookie, and the response can re-issue it at the target locale's path. A
 * `Set-Cookie` path need not match the request path.
 *
 * An endpoint rather than a page, mirroring `access/logout`: the subtree's
 * `+layout.server.ts` guard does not run for endpoints, so a switch made with a
 * session that has just expired still lands somewhere sensible instead of
 * looping through the guard.
 */
export const GET: RequestHandler = async (event) => {
	const target = event.url.searchParams.get('to') ?? '';
	if (!getConfig().locales.includes(target)) {
		error(404, `Locale "${target}" is not enabled on this deployment.`);
	}

	const token = event.cookies.get(REQUESTER_SESSION_COOKIE);
	if (token) {
		// The session's own expiry, not a fresh TTL: switching language must not
		// silently extend a session, and a cookie is all `cookies.get` returns.
		const session = await validateRequesterSession(getDb(), token);

		if (session) {
			event.cookies.set(REQUESTER_SESSION_COOKIE, token, {
				...requesterCookieOptions(target),
				expires: session.expiresAt
			});
		}

		// Dropped from the locale being left, so the guarantee that exactly one
		// cookie exists survives the switch. Distinct paths, so this and the set
		// above are two independent Set-Cookie headers rather than a conflict.
		event.cookies.delete(REQUESTER_SESSION_COOKIE, requesterCookieOptions(event.locals.locale));
	}

	redirect(303, localizePath('/access', target));
};
