import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationsAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import {
	deleteSubprocessor,
	getSubprocessorForAdmin,
	setSubprocessorTranslation,
	updateSubprocessor
} from '$lib/server/content/subprocessors';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getSubprocessorForAdmin(getDb(), params.id);
	if (!item) error(404, 'Subprocessor not found');
	return { subprocessor: item };
};

/** An empty date input submits '', which is "no date", not an invalid one. */
const optionalDate = z
	.string()
	.trim()
	.transform((raw) => (raw ? new Date(raw) : null))
	.refine((date) => date === null || !Number.isNaN(date.getTime()), { message: 'invalid date' });

const optionalText = z
	.string()
	.trim()
	.transform((raw) => raw || null);

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'subprocessor',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			name: z.string().trim().min(1),
			legalEntity: z.string().trim().min(1),
			country: z
				.string()
				.trim()
				.regex(/^[A-Z]{2}$/),
			region: z.string().trim().min(1),
			position: z.coerce.number().int(),
			published: z.boolean(),
			hostingProvider: optionalText,
			dpaUrl: optionalText,
			startedAt: optionalDate,
			endedAt: optionalDate
		}),
		read: (form) => ({
			slug: form.get('slug'),
			name: form.get('name'),
			legalEntity: form.get('legalEntity'),
			country: String(form.get('country') ?? '').toUpperCase(),
			region: form.get('region'),
			position: form.get('position') ?? 0,
			published: form.get('published') === 'on',
			hostingProvider: form.get('hostingProvider') ?? '',
			dpaUrl: form.get('dpaUrl') ?? '',
			startedAt: form.get('startedAt') ?? '',
			endedAt: form.get('endedAt') ?? ''
		}),
		update: (db, id, data) => updateSubprocessor(db, id, data),
		isPublished: (data) => data.published,
		fallbackField: 'slug'
	}),

	saveTranslations: saveTranslationsAction({
		type: 'subprocessor',
		required: ['purpose', 'dataCategories'],
		set: (db, id, locale, values) =>
			setSubprocessorTranslation(db, id, locale, {
				purpose: values.purpose!,
				dataCategories: values.dataCategories!
			})
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteSubprocessor(db, event.params.id);

		await recordEvent(db, {
			action: 'subprocessor.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'subprocessor',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/subprocessors', event.locals.locale));
	}
};
