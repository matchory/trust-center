import { m } from '$lib/paraglide/messages.js';

export interface PortalSection {
	/** Locale-free path, e.g. `/documents`. `localizePath` adds the prefix. */
	path: string;
	/** A Paraglide message accessor, called at render time so it resolves per request. */
	label: () => string;
}

/**
 * The portal's navigation, in display order. Each content type appends its own
 * entry here as it lands, so adding a section is one line rather than an edit
 * to the layout, the landing page, and the sitemap.
 */
export const PORTAL_SECTIONS: PortalSection[] = [];

void m;
