import { listRequestsForAdmin } from '$lib/server/access/requests';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	requests: await listRequestsForAdmin(getDb())
});
