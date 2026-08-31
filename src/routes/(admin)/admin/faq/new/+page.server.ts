import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { createAnswer } from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	category: z.string().trim().min(1)
});

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			category: form.get('category')
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		// Visibility is not offered here: an answer starts internal and reaches
		// the public FAQ only when somebody decides on the edit page that it
		// should.
		let id: string;
		try {
			id = await createAnswer(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'slug');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		await recordEvent(db, {
			action: 'answer.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'answer',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data.slug, category: parsed.data.category }
		});

		redirect(303, localizePath(`/admin/faq/${id}`, locals.locale));
	}
};
