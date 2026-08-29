import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import {
	deleteCertification,
	getCertificationForAdmin,
	setCertificationTranslation,
	updateCertification
} from '$lib/server/content/certifications';
import { listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const item = await getCertificationForAdmin(db, params.id);
	if (!item) error(404, 'Certification not found');

	return { certification: item, documents: await listDocumentsForAdmin(db) };
};

/** An empty date input submits '', which is "no date", not an invalid one. */
const optionalDate = z
	.string()
	.trim()
	.transform((raw) => (raw ? new Date(raw) : null))
	.refine((date) => date === null || !Number.isNaN(date.getTime()), { message: 'invalid date' });

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'certification',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			framework: z.string().trim().min(1),
			issuer: z.string().trim().min(1),
			position: z.coerce.number().int(),
			published: z.boolean(),
			// The empty option means "no certificate document", not a missing field.
			certificateDocumentId: z
				.string()
				.trim()
				.transform((raw) => raw || null),
			validFrom: optionalDate,
			validUntil: optionalDate
		}),
		read: (form) => ({
			slug: form.get('slug'),
			framework: form.get('framework'),
			issuer: form.get('issuer'),
			position: form.get('position') ?? 0,
			published: form.get('published') === 'on',
			certificateDocumentId: form.get('certificateDocumentId') ?? '',
			validFrom: form.get('validFrom') ?? '',
			validUntil: form.get('validUntil') ?? ''
		}),
		update: (db, id, data) => updateCertification(db, id, data),
		isPublished: (data) => data.published,
		fallbackField: 'slug'
	}),

	saveTranslation: saveTranslationAction({
		type: 'certification',
		required: ['scope'],
		set: (db, id, locale, values) =>
			setCertificationTranslation(db, id, locale, { scope: values.scope! })
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteCertification(db, event.params.id);

		await recordEvent(db, {
			action: 'certification.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'certification',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/certifications', event.locals.locale));
	}
};
