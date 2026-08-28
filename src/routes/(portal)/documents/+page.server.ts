import { getConfig } from '$lib/server/config';
import { listPublicDocuments } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const { defaultLocale } = getConfig();
	const categories = await listPublicDocuments(getDb(), {
		locale: locals.locale,
		defaultLocale
	});

	// Locale lives in the path, so this response varies by nothing a cache
	// cannot see. Short and revalidatable rather than long: an operator
	// publishing a new AVV expects it visible in seconds.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });

	return { categories };
};
