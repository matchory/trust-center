import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteSubprocessor,
	getSubprocessorForAdmin,
	setSubprocessorTranslation,
	updateSubprocessor
} from '$lib/server/content/subprocessors';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getSubprocessorForAdmin(getDb(), params.id);
	if (!item) error(404, 'Subprocessor not found');
	return { subprocessor: item };
};

/** One shape for every action failure, so the form can narrow on `field` alone. */
type SubprocessorActionFailure = { field: string; locale?: string };

/** An empty date input submits '', which is "no date", not an invalid one. */
const optionalDate = (value: FormDataEntryValue | null): Date | null => {
	const text = String(value ?? '').trim();
	return text ? new Date(text) : null;
};

const optionalText = (value: FormDataEntryValue | null): string | null =>
	String(value ?? '').trim() || null;

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
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
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				name: form.get('name'),
				legalEntity: form.get('legalEntity'),
				country: String(form.get('country') ?? '').toUpperCase(),
				region: form.get('region'),
				position: form.get('position') ?? 0
			});
		if (!parsed.success) {
			return fail<SubprocessorActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});
		}

		const published = form.get('published') === 'on';
		const db = getDb();

		await updateSubprocessor(db, params.id, {
			...parsed.data,
			hostingProvider: optionalText(form.get('hostingProvider')),
			dpaUrl: optionalText(form.get('dpaUrl')),
			startedAt: optionalDate(form.get('startedAt')),
			endedAt: optionalDate(form.get('endedAt')),
			published
		});

		await recordEvent(db, {
			action: published ? 'subprocessor.published' : 'subprocessor.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'subprocessor',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data, published }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale') ?? '');
		if (!getConfig().locales.includes(locale)) {
			return fail<SubprocessorActionFailure>(400, { field: 'locale' });
		}

		const purpose = String(form.get('purpose') ?? '').trim();
		const dataCategories = String(form.get('dataCategories') ?? '').trim();
		if (!purpose) return fail<SubprocessorActionFailure>(400, { field: 'purpose', locale });
		if (!dataCategories) {
			return fail<SubprocessorActionFailure>(400, { field: 'dataCategories', locale });
		}

		const db = getDb();
		await setSubprocessorTranslation(db, params.id, locale, { purpose, dataCategories });

		await recordEvent(db, {
			action: 'subprocessor.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'subprocessor',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteSubprocessor(db, params.id);

		await recordEvent(db, {
			action: 'subprocessor.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'subprocessor',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/subprocessors', locals.locale));
	}
};
