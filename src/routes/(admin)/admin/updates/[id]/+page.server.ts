import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteUpdate,
	getUpdateForAdmin,
	setUpdateTranslation,
	updateUpdate
} from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getUpdateForAdmin(getDb(), params.id);
	if (!item) error(404, 'Update not found');
	return { post: item };
};

/** One shape for every action failure, so the form can narrow on `field` alone. */
type UpdateActionFailure = { field: string; locale?: string };

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				kind: z.enum(UPDATE_KINDS)
			})
			.safeParse({ slug: form.get('slug'), kind: form.get('kind') });
		if (!parsed.success) {
			return fail<UpdateActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});
		}

		// An empty datetime-local means "not published", not an invalid date.
		const raw = String(form.get('publishedAt') ?? '').trim();
		const publishedAt = raw ? new Date(raw) : null;
		if (publishedAt && Number.isNaN(publishedAt.getTime())) {
			return fail<UpdateActionFailure>(400, { field: 'publishedAt' });
		}

		const db = getDb();
		await updateUpdate(db, params.id, { ...parsed.data, publishedAt });

		await recordEvent(db, {
			action:
				publishedAt && publishedAt.getTime() <= Date.now() ? 'update.published' : 'update.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'update_post',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data, publishedAt: publishedAt?.toISOString() ?? null }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale') ?? '');
		if (!getConfig().locales.includes(locale)) {
			return fail<UpdateActionFailure>(400, { field: 'locale' });
		}

		const title = String(form.get('title') ?? '').trim();
		const body = String(form.get('body') ?? '').trim();
		if (!title) return fail<UpdateActionFailure>(400, { field: 'title', locale });
		if (!body) return fail<UpdateActionFailure>(400, { field: 'body', locale });

		const db = getDb();
		await setUpdateTranslation(db, params.id, locale, { title, body });

		await recordEvent(db, {
			action: 'update.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'update_post',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteUpdate(db, params.id);

		await recordEvent(db, {
			action: 'update.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'update_post',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/updates', locals.locale));
	}
};
