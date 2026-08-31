import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_TIERS } from '$lib/content-types';
import { recordEvent } from '$lib/server/audit';
import { createDocument, listCategories } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { localizePath } from '$lib/i18n/locale';
import type { Actions, PageServerLoad } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	categoryId: z.string().uuid(),
	tier: z.enum(DOCUMENT_TIERS)
});

export const load: PageServerLoad = async () => ({ categories: await listCategories(getDb()) });

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			categoryId: form.get('categoryId'),
			tier: form.get('tier') ?? 'public'
		});

		if (!parsed.success) {
			return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });
		}

		const db = getDb();
		let id: string;
		try {
			id = await createDocument(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'slug');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		await recordEvent(db, {
			action: 'document.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data.slug, tier: parsed.data.tier }
		});

		redirect(303, localizePath(`/admin/documents/${id}`, locals.locale));
	}
};
