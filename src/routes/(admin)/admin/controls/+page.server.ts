import { listControlGroups, listControlsForAdmin } from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const db = getDb();
	const [controls, groups] = await Promise.all([listControlsForAdmin(db), listControlGroups(db)]);
	return { controls, groups };
};
