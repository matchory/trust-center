import { m } from '$lib/paraglide/messages.js';

export interface AdminSection {
	path: string;
	label: () => string;
}

/** One entry per content type, in the order the admin nav shows them. */
export const ADMIN_SECTIONS: AdminSection[] = [
	{ path: '/admin/requests', label: () => m.nav_requests() },
	{ path: '/admin/documents', label: () => m.nav_documents() },
	{ path: '/admin/controls', label: () => m.nav_controls() },
	{ path: '/admin/certifications', label: () => m.nav_certifications() },
	{ path: '/admin/subprocessors', label: () => m.nav_subprocessors() },
	{ path: '/admin/faq', label: () => m.nav_faq() },
	{ path: '/admin/updates', label: () => m.nav_updates() },
	{ path: '/admin/settings/branding', label: () => m.admin_branding() }
];
