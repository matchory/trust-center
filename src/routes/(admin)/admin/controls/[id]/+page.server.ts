import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { CONTROL_STATUSES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteControl,
	getControlForAdmin,
	listControlGroups,
	setControlEvidence,
	setControlTranslation,
	updateControl
} from '$lib/server/content/controls';
import { listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const item = await getControlForAdmin(db, params.id);
	if (!item) error(404, 'Control not found');

	const [groups, documents] = await Promise.all([listControlGroups(db), listDocumentsForAdmin(db)]);
	return { control: item, groups, documents };
};

/** One shape for every action failure, so the form can narrow on `field` alone. */
type ControlActionFailure = { field: string; locale?: string };

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				groupId: z.string().uuid(),
				status: z.enum(CONTROL_STATUSES),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				groupId: form.get('groupId'),
				status: form.get('status'),
				position: form.get('position') ?? 0
			});
		if (!parsed.success)
			return fail<ControlActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});

		const published = form.get('published') === 'on';
		const db = getDb();

		await updateControl(db, params.id, { ...parsed.data, published });
		// Evidence is submitted as the complete set every time, so an empty
		// selection clears it — `getAll` returns [] and setControlEvidence
		// deletes the rows.
		await setControlEvidence(db, params.id, form.getAll('evidence').map(String));

		await recordEvent(db, {
			action: published ? 'control.published' : 'control.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data, published }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale))
			return fail<ControlActionFailure>(400, { field: 'locale' });

		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail<ControlActionFailure>(400, { field: 'title', locale });

		const db = getDb();
		await setControlTranslation(db, params.id, locale, {
			title,
			description: String(form.get('description') ?? '').trim() || null
		});

		await recordEvent(db, {
			action: 'control.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { translation: locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteControl(db, params.id);
		await recordEvent(db, {
			action: 'control.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/controls', locals.locale));
	}
};
