import { error, fail } from '@sveltejs/kit';
import { listGroups } from '$lib/server/access/groups';
import { queryEvents } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { getRequesterForAdmin } from '$lib/server/identity/requester';
import { purgeRequester } from '$lib/server/purge';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const db = getDb();
	const person = await getRequesterForAdmin(db, params.id);
	if (!person) error(404, 'Not found');

	const groups = await listGroups(db);

	return {
		requester: person,
		// Resolved here so the scope summary renders a name rather than a uuid.
		groupNames: Object.fromEntries(
			groups.map((group) => [group.id, group.names[locals.locale] ?? group.slug])
		),
		// Pseudonymized events no longer carry an actor id, so a purged
		// requester's history correctly comes back empty here.
		events: await queryEvents(db, { actorId: params.id, limit: 50 })
	};
};

export const actions: Actions = {
	purge: async (event) => {
		const db = getDb();
		const person = await getRequesterForAdmin(db, event.params.id);
		if (!person) error(404, 'Not found');

		// Irreversible, so a second purge is refused rather than quietly
		// rewriting an already-blanked row and logging a second erasure.
		if (person.purgedAt) return fail(409, { failed: true });

		await purgeRequester(db, {
			requesterId: event.params.id,
			staffUserId: event.locals.staff!.id,
			ip: clientIp(event)
		});

		return { purged: true };
	}
};
