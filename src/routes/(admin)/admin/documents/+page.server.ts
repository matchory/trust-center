import { listCategories, listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const db = getDb();
	const [documents, categories] = await Promise.all([
		listDocumentsForAdmin(db),
		listCategories(db)
	]);
	return { documents, categories };
};
