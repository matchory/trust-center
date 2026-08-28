import { getConfig } from '$lib/server/config';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, setHeaders }) => {
	if (!locals.staff) redirect(303, '/');
	// On the response as well as in the head, so it covers the group's
	// non-HTML responses too.
	setHeaders({ 'x-robots-tag': 'noindex, nofollow' });
	const { locales, defaultLocale } = getConfig();
	return { staff: locals.staff, locale: locals.locale, locales, defaultLocale };
};
