import { redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { SESSION_COOKIE, STAFF_COOKIE_OPTIONS, revokeStaffSession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { localizePath } from '$lib/i18n/locale';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { cookies, locals } = event;
	const db = getDb();
	const token = cookies.get(SESSION_COOKIE);

	if (token) {
		await revokeStaffSession(db, token);
		if (locals.staff) {
			await recordEvent(db, {
				action: 'staff.logout',
				actor: { type: 'staff', id: locals.staff.id },
				subjectType: 'staff',
				subjectId: locals.staff.id,
				ip: clientIp(event) ?? undefined
			});
		}
	}

	// Every attribute must match how it was set, or the browser rejects the
	// deletion and the stale cookie survives — see STAFF_COOKIE_OPTIONS.
	cookies.delete(SESSION_COOKIE, STAFF_COOKIE_OPTIONS);
	redirect(303, localizePath('/', locals.locale));
};
