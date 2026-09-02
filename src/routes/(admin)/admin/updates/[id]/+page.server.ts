import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationsAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import { listSubprocessorsForAdmin } from '$lib/server/content/subprocessors';
import {
	deleteUpdate,
	getUpdateForAdmin,
	setUpdateSubprocessors,
	setUpdateTranslation,
	updateUpdate
} from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getUpdateForAdmin(getDb(), params.id);
	if (!item) error(404, 'Update not found');
	return { post: item, subprocessors: await listSubprocessorsForAdmin(getDb()) };
};

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'update',
		// The audit subject has always been `update_post` while the action reads
		// `update.*`; keeping both preserves continuity with existing rows.
		subjectType: 'update_post',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			kind: z.enum(UPDATE_KINDS),
			// An empty datetime-local means "not published", not an invalid date.
			publishedAt: z
				.string()
				.trim()
				.transform((raw) => (raw ? new Date(raw) : null))
				.refine((date) => date === null || !Number.isNaN(date.getTime()), {
					message: 'invalid date'
				}),
			// Deduped for the same reason as the portal topic arrays: a repeated
			// id raises a primary-key violation in setUpdateSubprocessors, which
			// saveMetaAction's catch reports as the slug being taken.
			subprocessorIds: z.array(z.string().uuid()).transform((ids) => [...new Set(ids)])
		}),
		read: (form) => ({
			slug: form.get('slug'),
			kind: form.get('kind'),
			publishedAt: form.get('publishedAt') ?? '',
			subprocessorIds: form.getAll('subprocessorIds').map(String).filter(Boolean)
		}),
		update: async (db, id, data) => {
			const { subprocessorIds, ...meta } = data;
			await updateUpdate(db, id, meta);
			// A set-valued field beside scalar metadata, exactly as the control
			// editor's evidence set is. `update` receives `db` so a call site
			// needing two statements does both here rather than forking the helper.
			await setUpdateSubprocessors(db, id, subprocessorIds);
		},
		isPublished: (data) => data.publishedAt !== null && data.publishedAt.getTime() <= Date.now(),
		// Ids are references, not post metadata — the control editor made the same
		// call, and the audit log must not accumulate id lists it cannot query on.
		meta: ({ subprocessorIds, ...rest }) => ({
			slug: rest.slug,
			kind: rest.kind,
			publishedAt: rest.publishedAt?.toISOString() ?? null,
			subprocessorCount: subprocessorIds.length
		}),
		fallbackField: 'slug'
	}),

	saveTranslations: saveTranslationsAction({
		type: 'update',
		subjectType: 'update_post',
		required: ['title', 'body'],
		set: (db, id, locale, values) =>
			setUpdateTranslation(db, id, locale, { title: values.title!, body: values.body! })
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteUpdate(db, event.params.id);

		await recordEvent(db, {
			action: 'update.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'update_post',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/updates', event.locals.locale));
	}
};
