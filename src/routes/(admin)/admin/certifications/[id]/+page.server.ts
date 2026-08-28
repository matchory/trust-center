import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteCertification,
	getCertificationForAdmin,
	setCertificationTranslation,
	updateCertification
} from '$lib/server/content/certifications';
import { listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const item = await getCertificationForAdmin(db, params.id);
	if (!item) error(404, 'Certification not found');

	return { certification: item, documents: await listDocumentsForAdmin(db) };
};

/** One shape for every action failure, so the form can narrow on `field` alone. */
type CertificationActionFailure = { field: string; locale?: string };

/** An empty date input submits '', which is "no date", not an invalid one. */
const optionalDate = (value: FormDataEntryValue | null): Date | null => {
	const text = String(value ?? '').trim();
	return text ? new Date(text) : null;
};

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				framework: z.string().trim().min(1),
				issuer: z.string().trim().min(1),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				framework: form.get('framework'),
				issuer: form.get('issuer'),
				position: form.get('position') ?? 0
			});
		if (!parsed.success) {
			return fail<CertificationActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});
		}

		const published = form.get('published') === 'on';
		// The empty option means "no certificate document", not a missing field.
		const certificateDocumentId = String(form.get('certificateDocumentId') ?? '') || null;
		const db = getDb();

		await updateCertification(db, params.id, {
			...parsed.data,
			certificateDocumentId,
			validFrom: optionalDate(form.get('validFrom')),
			validUntil: optionalDate(form.get('validUntil')),
			published
		});

		await recordEvent(db, {
			action: published ? 'certification.published' : 'certification.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'certification',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data, published, certificateDocumentId }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale') ?? '');
		if (!getConfig().locales.includes(locale)) {
			return fail<CertificationActionFailure>(400, { field: 'locale' });
		}

		const scope = String(form.get('scope') ?? '').trim();
		if (!scope) return fail<CertificationActionFailure>(400, { field: 'scope', locale });

		const db = getDb();
		await setCertificationTranslation(db, params.id, locale, { scope });

		await recordEvent(db, {
			action: 'certification.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'certification',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteCertification(db, params.id);

		await recordEvent(db, {
			action: 'certification.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'certification',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/certifications', locals.locale));
	}
};
