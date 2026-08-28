import { getConfig } from '$lib/server/config';
import { listPublicCertifications } from '$lib/server/content/certifications';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const certifications = await listPublicCertifications(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { certifications };
};
