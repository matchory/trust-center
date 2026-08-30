import { listRules } from '$lib/server/access/rules';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ rules: await listRules(getDb()) });
