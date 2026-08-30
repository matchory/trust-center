import { error, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import {
	deleteGroup,
	getGroup,
	groupSchema,
	setGroupTranslation,
	updateGroup
} from '$lib/server/access/groups';
import { saveMetaAction, translationAction } from '$lib/server/admin/actions';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const group = await getGroup(getDb(), params.id);
	if (!group) error(404, 'Group not found');
	return { group };
};

export const actions: Actions = {
	// The meta half is `saveMetaAction` at its plainest — slug and position, no
	// published state — exactly as `/admin/rules/[id]` uses it.
	saveMeta: saveMetaAction({
		type: 'access_group',
		schema: groupSchema,
		read: (form) => ({ slug: form.get('slug'), position: form.get('position') ?? 0 }),
		update: (db, id, data) => updateGroup(db, id, data),
		fallbackField: 'slug'
	}),

	// Not `saveTranslationAction`: that helper writes one locale per POST, and
	// this form submits every locale at once the way the categories page does.
	// Forcing one POST per locale here would be the helper dictating the form.
	saveTranslations: async (event) => {
		const form = await event.request.formData();
		const db = getDb();
		const id = event.params.id;
		const written: string[] = [];

		await saveTranslationsFromForm(
			form,
			(values, locale) => {
				const name = String(values.get(`name.${locale}`) ?? '').trim();
				if (!name) return null;
				return {
					name,
					description: String(values.get(`description.${locale}`) ?? '').trim() || null
				};
			},
			async (locale, values) => {
				await setGroupTranslation(db, id, locale, values);
				written.push(locale);
			}
		);

		await recordEvent(db, {
			action: translationAction('access_group'),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { locales: written }
		});

		return { saved: true };
	},

	remove: async (event) => {
		const db = getDb();
		// Read before the delete: the audit row is the only place a deleted group
		// survives, and "what was in that group" is asked afterwards.
		const group = await getGroup(db, event.params.id);
		if (!group) error(404, 'Group not found');

		await deleteGroup(db, event.params.id);

		await recordEvent(db, {
			action: 'access_group.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: group.slug, documentCount: group.documentCount }
		});

		redirect(303, localizePath('/admin/groups', event.locals.locale));
	}
};
