import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { createCertification } from '$lib/server/content/certifications';
import { getDb } from '$lib/server/db/instance';
import { localizePath } from '$lib/i18n/locale';
import type { Actions } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	framework: z.string().trim().min(1),
	issuer: z.string().trim().min(1)
});

export const actions: Actions = {
	default: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			framework: form.get('framework'),
			issuer: form.get('issuer')
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		const id = await createCertification(db, {
			...parsed.data,
			validFrom: null,
			validUntil: null,
			certificateDocumentId: null
		});

		await recordEvent(db, {
			action: 'certification.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'certification',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data.slug, framework: parsed.data.framework }
		});

		redirect(303, localizePath(`/admin/certifications/${id}`, locals.locale));
	}
};
