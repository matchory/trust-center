import { getConfig } from '$lib/server/config';
import { listPublicAnswers } from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const groups = await listPublicAnswers(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { groups };
};
