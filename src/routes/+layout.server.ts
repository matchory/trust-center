import { redirect } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';
import { getBranding } from '$lib/server/content/branding';
import { getDb } from '$lib/server/db/instance';
import { localizePath } from '$lib/i18n/locale';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	// Every page lives at a locale-prefixed URL, so an unprefixed request is
	// negotiated once and redirected. That keeps every content URL stable and
	// cacheable, and makes canonical/hreflang answerable (Task 17).
	if (locals.pathLocale === null) {
		redirect(302, `${localizePath(url.pathname, locals.locale)}${url.search}`);
	}

	// Reroute maps every locale prefix to the same route id, so without
	// reading something URL-derived here too, SvelteKit would treat
	// client-side navigation between /de and /en as not requiring this load
	// to rerun, and `data.locale` would never update.
	void url.pathname;

	const { locales, defaultLocale } = getConfig();
	return {
		locale: locals.locale,
		locales,
		defaultLocale,
		branding: await getBranding(getDb())
	};
};
