import { auditSinkBacklog } from '$lib/server/auditsink/status';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, setHeaders }) => {
	if (!locals.staff) redirect(303, '/');
	// On the response as well as in the head, so it covers the group's
	// non-HTML responses too.
	setHeaders({ 'x-robots-tag': 'noindex, nofollow' });
	const { locales, defaultLocale } = getConfig();

	return {
		staff: locals.staff,
		locale: locals.locale,
		locales,
		defaultLocale,
		// One indexed query, and none at all while the sink is off — which is the
		// default. A stuck sink must be visible to an operator who never opens
		// the integrations page (audit sink spec §9, §10).
		auditSinkBacklog: await auditSinkBacklog(getDb())
	};
};
