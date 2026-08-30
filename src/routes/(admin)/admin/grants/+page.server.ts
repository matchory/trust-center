import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { listGrantsForAdmin, revokeGrant } from '$lib/server/access/grants';
import { groupNames } from '$lib/server/access/groups';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const db = getDb();
	// Independent reads, so they go together: the group names are for the scope
	// summary and have nothing to say about which grants exist.
	const [grants, names] = await Promise.all([
		listGrantsForAdmin(db),
		groupNames(db, locals.locale)
	]);

	return { grants, groupNames: names };
};

const grantId = z.string().uuid();

export const actions: Actions = {
	revoke: async (event) => {
		const form = await event.request.formData();
		const parsed = grantId.safeParse(form.get('grantId'));
		// Validated rather than passed through: an id that is not a uuid reaches
		// Postgres as a cast error and 500s a page that should have said no.
		if (!parsed.success) return fail(400, { failed: true });

		const db = getDb();
		await revokeGrant(db, parsed.data, event.locals.staff!.id);

		// Nothing derived from the requester: spec §10 keeps their personal data
		// out of meta, and the grant id already names the row.
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_grant',
			subjectId: parsed.data,
			ip: clientIp(event) ?? undefined
		});

		return { revoked: true };
	}
};
