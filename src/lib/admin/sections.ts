import { m } from '$lib/paraglide/messages.js';

export interface AdminSection {
	path: string;
	label: () => string;
	/**
	 * The role a section is restricted to. A section without one is open to
	 * every signed-in staff member. The nav hides what the route would refuse,
	 * so an approver is never offered a link that 403s.
	 */
	role?: 'admin' | 'approver';
}

/** One entry per content type, in the order the admin nav shows them. */
export const ADMIN_SECTIONS: AdminSection[] = [
	{ path: '/admin/requests', label: () => m.nav_requests() },
	{ path: '/admin/grants', label: () => m.nav_grants() },
	{ path: '/admin/rules', label: () => m.nav_rules() },
	{ path: '/admin/groups', label: () => m.nav_groups() },
	{ path: '/admin/requesters', label: () => m.nav_requesters() },
	{ path: '/admin/documents', label: () => m.nav_documents() },
	{ path: '/admin/controls', label: () => m.nav_controls() },
	{ path: '/admin/certifications', label: () => m.nav_certifications() },
	{ path: '/admin/subprocessors', label: () => m.nav_subprocessors() },
	{ path: '/admin/faq', label: () => m.nav_faq() },
	{ path: '/admin/updates', label: () => m.nav_updates() },
	{ path: '/admin/settings/branding', label: () => m.admin_branding() },
	{ path: '/admin/settings/access', label: () => m.admin_access_settings() },
	{ path: '/admin/audit', label: () => m.nav_audit(), role: 'admin' }
];
