import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.staff) redirect(303, '/');
	return { staff: locals.staff, locale: locals.locale };
};
