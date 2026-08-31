import { duplicateFail } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { createUpdate } from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	kind: z.enum(UPDATE_KINDS)
});

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			kind: form.get('kind') ?? 'advisory'
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		// No publication date: a post is a draft until somebody dates it.
		let id: string;
		try {
			id = await createUpdate(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			return duplicateFail(cause, 'slug');
		}

		await recordEvent(db, {
			action: 'update.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'update_post',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data.slug, kind: parsed.data.kind }
		});

		redirect(303, localizePath(`/admin/updates/${id}`, locals.locale));
	}
};
