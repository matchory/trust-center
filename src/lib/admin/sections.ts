import { m } from '$lib/paraglide/messages.js';

export interface AdminSection {
	path: string;
	label: () => string;
}

/** One entry per content type, in the order the admin nav shows them. */
export const ADMIN_SECTIONS: AdminSection[] = [
	{ path: '/admin/documents', label: () => m.nav_documents() },
	{ path: '/admin/controls', label: () => m.nav_controls() }
];
