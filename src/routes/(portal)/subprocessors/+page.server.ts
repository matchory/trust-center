import { getConfig } from '$lib/server/config';
import { listPublicSubprocessors } from '$lib/server/content/subprocessors';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const { current, former } = await listPublicSubprocessors(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { current, former };
};
