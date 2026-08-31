import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { CONTROL_STATUSES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { createControl, listControlGroups } from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	groupId: z.string().uuid(),
	status: z.enum(CONTROL_STATUSES)
});

export const load: PageServerLoad = async () => ({ groups: await listControlGroups(getDb()) });

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			groupId: form.get('groupId'),
			status: form.get('status') ?? 'planned'
		});
		if (!parsed.success) return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });

		const db = getDb();
		let id: string;
		try {
			id = await createControl(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'slug');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		await recordEvent(db, {
			action: 'control.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data.slug }
		});

		redirect(303, localizePath(`/admin/controls/${id}`, locals.locale));
	}
};
