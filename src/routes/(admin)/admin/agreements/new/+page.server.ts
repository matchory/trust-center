import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { createTemplate, templateSchema } from '$lib/server/nda/templates';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = templateSchema.safeParse({ slug: form.get('slug') });

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		let id: string;
		try {
			id = await createTemplate(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'slug');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		// Operator configuration, not requester data, so the whole thing belongs
		// in meta — the same reasoning `access_rule.created` and
		// `access_group.created` record.
		await recordEvent(db, {
			action: 'nda_template.created',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { ...parsed.data }
		});

		redirect(303, localizePath(`/admin/agreements/${id}`, event.locals.locale));
	}
};
