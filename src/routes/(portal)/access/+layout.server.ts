import { redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import type { LayoutServerLoad } from './$types';

/**
 * Everything under /access is grant-filtered and therefore uncacheable and
 * personal. `verify` is the one exception: it is how a person arrives without
 * a session yet, and it is the only page here a stranger may see.
 */
export const load: LayoutServerLoad = async ({ locals, url, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });

	const isVerify = url.pathname.endsWith('/access/verify');
	if (!locals.requester && !isVerify) {
		// Not a 401: an expired session is the ordinary case, and the useful
		// answer is the form that gets them a new link.
		redirect(303, localizePath('/request', locals.locale));
	}

	return { requester: locals.requester };
};
