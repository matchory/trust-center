import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// This load function only reads `locals.locale`, which SvelteKit's
	// dependency tracking does not watch — reroute maps `/` and `/en` to the
	// same route id, so without reading something URL-derived, SvelteKit
	// would treat client-side navigation between them as not requiring a
	// re-run, and `data.locale` would never update. Reading `url.pathname`
	// marks this load as URL-dependent so it reruns on every navigation.
	void url.pathname;
	return { locale: locals.locale };
};
