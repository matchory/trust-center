import { getConfig } from '$lib/server/config';
import { listPublicUpdates } from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const posts = await listPublicUpdates(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { posts };
};
