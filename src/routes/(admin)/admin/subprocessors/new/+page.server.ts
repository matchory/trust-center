import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { createSubprocessor } from '$lib/server/content/subprocessors';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	name: z.string().trim().min(1),
	legalEntity: z.string().trim().min(1),
	// ISO 3166-1 alpha-2, which Intl.DisplayNames resolves on the portal.
	country: z
		.string()
		.trim()
		.regex(/^[A-Z]{2}$/),
	region: z.string().trim().min(1)
});

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			name: form.get('name'),
			legalEntity: form.get('legalEntity'),
			country: String(form.get('country') ?? '').toUpperCase(),
			region: form.get('region')
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		const id = await createSubprocessor(db, {
			...parsed.data,
			hostingProvider: null,
			dpaUrl: null,
			startedAt: null,
			endedAt: null
		});

		await recordEvent(db, {
			action: 'subprocessor.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'subprocessor',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data.slug, country: parsed.data.country }
		});

		redirect(303, localizePath(`/admin/subprocessors/${id}`, locals.locale));
	}
};
