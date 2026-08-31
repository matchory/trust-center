import { redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { outstandingAgreements } from '$lib/server/nda/acceptance';
import { acceptanceScope } from '$lib/server/nda/settings';
import type { PageServerLoad } from './$types';

/**
 * What this requester still owes. Inside `/{locale}/access` deliberately: it is
 * the only subtree the requester cookie is scoped to, and the click-through
 * needs to know who is signing.
 */
export const load: PageServerLoad = async ({ locals }) => {
	// The layout guard already sent an anonymous visitor to the request form.
	// This is that guarantee restated for the type checker, not a second policy.
	const requester = locals.requester;
	if (!requester) redirect(303, localizePath('/request', locals.locale));

	const db = getDb();
	const config = getConfig();

	const agreements = await outstandingAgreements(db, requester.id, {
		locales: config.locales,
		locale: locals.locale,
		scope: await acceptanceScope(db)
	});

	return { agreements };
};
