import { redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import {
	REQUESTER_SESSION_COOKIE,
	requesterCookieOptions,
	revokeRequesterSession
} from '$lib/server/identity/requester';
import type { RequestHandler } from './$types';

/**
 * An endpoint rather than a form action, mirroring the staff sign-out: the
 * subtree's `+layout.server.ts` guard does not run for endpoints, so signing
 * out still works when the session it is revoking has already expired.
 */
export const POST: RequestHandler = async (event) => {
	const db = getDb();
	const token = event.cookies.get(REQUESTER_SESSION_COOKIE);
	const requesterId = event.locals.requester?.id;

	if (token) {
		// Revoked at the server, not merely forgotten at the client: a cookie
		// copied off the wire must stop working the moment someone signs out.
		await revokeRequesterSession(db, token);

		if (requesterId) {
			await recordEvent(db, {
				action: 'requester.signed_out',
				actor: { type: 'requester', id: requesterId },
				subjectType: 'requester',
				subjectId: requesterId,
				ip: clientIp(event) ?? undefined,
				ua: event.request.headers.get('user-agent') ?? undefined
			});
		}
	}

	// Every attribute must match how it was set, or the delete silently does
	// nothing — see requesterCookieOptions.
	event.cookies.delete(REQUESTER_SESSION_COOKIE, requesterCookieOptions(event.locals.locale));

	redirect(303, localizePath('/', event.locals.locale));
};
