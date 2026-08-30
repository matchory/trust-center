import { getDb } from '$lib/server/db/instance';
import { listRequestersForAdmin } from '$lib/server/identity/requester';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	requesters: await listRequestersForAdmin(getDb())
});
