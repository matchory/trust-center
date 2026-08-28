import { listAnswersForAdmin } from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ answers: await listAnswersForAdmin(getDb()) });
