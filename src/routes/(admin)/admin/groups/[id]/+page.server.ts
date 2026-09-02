import { error, fail, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import {
	deleteGroup,
	getGroup,
	groupSchema,
	setGroupTranslation,
	updateGroup
} from '$lib/server/access/groups';
import { ScopeGroupInUse } from '$lib/server/access/scope';
import { saveMetaAction, translationAction } from '$lib/server/admin/actions';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { listTemplates } from '$lib/server/nda/templates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const group = await getGroup(db, params.id);
	if (!group) error(404, 'Group not found');
	const templates = await listTemplates(db, getConfig().locales);
	return { group, templates };
};

export const actions: Actions = {
	// The meta half is `saveMetaAction` at its plainest — slug and position, no
	// published state — exactly as `/admin/rules/[id]` uses it.
	saveMeta: saveMetaAction({
		type: 'access_group',
		schema: groupSchema,
		read: (form) => ({
			slug: form.get('slug'),
			position: form.get('position') ?? 0,
			ndaTemplateId: form.get('ndaTemplateId') || null
		}),
		update: (db, id, data) => updateGroup(db, id, data),
		fallbackField: 'slug'
	}),

	// Not `saveTranslationsAction`: this predates it and reads through
	// `saveTranslationsFromForm`, which two other admin surfaces still use. With
	// a single required field the two are equivalent — the helper only refuses a
	// locale that is *partly* filled, which one field cannot be — so the split is
	// historical rather than semantic, and moving these two would leave both
	// mechanisms standing anyway.
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

		try {
			await deleteGroup(db, event.params.id);
		} catch (cause) {
			// A grant still names this group, and deleting it would silently
			// narrow that grant. The operator revokes or re-scopes first.
			if (cause instanceof ScopeGroupInUse) return fail(409, { field: 'group', message: 'in_use' });
			throw cause;
		}

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
