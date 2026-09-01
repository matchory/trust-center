import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { CONTROL_STATUSES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationsAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
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
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const item = await getControlForAdmin(db, params.id);
	if (!item) error(404, 'Control not found');

	const [groups, documents] = await Promise.all([listControlGroups(db), listDocumentsForAdmin(db)]);
	return { control: item, groups, documents };
};

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'control',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			groupId: z.string().uuid(),
			status: z.enum(CONTROL_STATUSES),
			position: z.coerce.number().int(),
			published: z.boolean(),
			evidence: z.array(z.string())
		}),
		read: (form) => ({
			slug: form.get('slug'),
			groupId: form.get('groupId'),
			status: form.get('status'),
			position: form.get('position') ?? 0,
			published: form.get('published') === 'on',
			evidence: form.getAll('evidence').map(String)
		}),
		update: async (db, id, data) => {
			const { evidence, ...meta } = data;
			await updateControl(db, id, meta);
			// Evidence is submitted as the complete set every time, so an empty
			// selection clears it — setControlEvidence deletes the rows.
			await setControlEvidence(db, id, evidence);
		},
		isPublished: (data) => data.published,
		// Evidence ids are a set of document references, not control metadata;
		// the previous implementation left them out of the audit meta too.
		meta: ({ evidence, ...rest }) => ({ ...rest, evidenceCount: evidence.length }),
		fallbackField: 'slug'
	}),

	saveTranslations: saveTranslationsAction({
		type: 'control',
		required: ['title'],
		optional: ['description'],
		set: (db, id, locale, values) =>
			setControlTranslation(db, id, locale, {
				title: values.title!,
				description: values.description ?? null
			})
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteControl(db, event.params.id);

		await recordEvent(db, {
			action: 'control.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'control',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/controls', event.locals.locale));
	}
};
