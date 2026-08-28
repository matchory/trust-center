import { redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { SESSION_COOKIE, revokeStaffSession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, locals, getClientAddress }) => {
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
				ip: getClientAddress()
			});
		}
	}

	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/');
};
