import { listUpdatesForAdmin } from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ posts: await listUpdatesForAdmin(getDb()) });
