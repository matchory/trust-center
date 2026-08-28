import { listSubprocessorsForAdmin } from '$lib/server/content/subprocessors';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	subprocessors: await listSubprocessorsForAdmin(getDb())
});
