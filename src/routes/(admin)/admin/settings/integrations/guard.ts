import { error } from '@sveltejs/kit';

/**
 * Admin only, not approver: an endpoint URL is where a prospect's name and
 * address get sent, and §6's threat model is the compromised admin. Same gate,
 * same shape as /admin/audit.
 *
 * The pages' own gate rather than the layout's — a layout cannot refuse what
 * only these routes know — and its own module because both route files and
 * every action in them need it. Three copies of a role test and its message is
 * how one of them comes to be forgotten.
 */
export function requireAdmin(locals: App.Locals): { id: string } {
	if (locals.staff?.role !== 'admin') {
		error(403, 'Integrations are restricted to administrators.');
	}
	return { id: locals.staff.id };
}
