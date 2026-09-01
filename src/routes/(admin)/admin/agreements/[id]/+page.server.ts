import { error } from '@sveltejs/kit';
import { saveMetaAction, translationAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import {
	createVersion,
	getTemplate,
	retireTemplate,
	setTemplateTranslation,
	templateSchema,
	updateTemplate
} from '$lib/server/nda/templates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const template = await getTemplate(getDb(), params.id, getConfig().locales);
	if (!template) error(404, 'Agreement not found');
	return { template, locales: getConfig().locales };
};

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'nda_template',
		schema: templateSchema,
		read: (form) => ({ slug: form.get('slug') }),
		update: (db, id, data) => updateTemplate(db, id, data),
		fallbackField: 'slug'
	}),

	// Not `saveTranslationsAction`: this predates it and reads through
	// `saveTranslationsFromForm`, which two other admin surfaces still use. With
	// a single required field the two are equivalent — the helper only refuses a
	// locale that is *partly* filled, which one field cannot be — so the split is
	// historical rather than semantic, and moving these two would leave both
	// mechanisms standing anyway.
	saveTranslations: async (event) => {
		const db = getDb();
		const form = await event.request.formData();
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
				await setTemplateTranslation(db, id, locale, values);
				written.push(locale);
			}
		);

		await recordEvent(db, {
			action: translationAction('nda_template'),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { locales: written }
		});

		return { saved: true };
	},

	createVersion: async (event) => {
		const db = getDb();
		const { versionId, version } = await createVersion(db, event.params.id);

		await recordEvent(db, {
			action: 'nda_template_version.created',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template_version',
			subjectId: versionId,
			ip: clientIp(event) ?? undefined,
			meta: { version }
		});

		return { saved: true };
	},

	// Retire, never delete (P3.16). There is deliberately no delete action on
	// this page at all: a template with acceptances behind it is evidence.
	retire: async (event) => {
		const db = getDb();
		await retireTemplate(db, event.params.id);

		await recordEvent(db, {
			action: 'nda_template.retired',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: {}
		});

		return { saved: true };
	}
};
