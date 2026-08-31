import { duplicateFail } from '$lib/server/admin/actions';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import {
	createCategory,
	deleteCategory,
	listCategories,
	setCategoryTranslation,
	updateCategory
} from '$lib/server/content/documents';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.min(1)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug');

export const load: PageServerLoad = async () => ({ categories: await listCategories(getDb()) });

export const actions: Actions = {
	create: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		let id: string;
		try {
			id = await createCategory(db, {
				slug: parsed.data,
				position: Number(form.get('position') ?? 0)
			});
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			return duplicateFail(cause, 'slug');
		}

		await saveTranslationsFromForm(
			form,
			(values, locale) => {
				const name = String(values.get(`name.${locale}`) ?? '').trim();
				return name ? { name } : null;
			},
			(locale, values) => setCategoryTranslation(db, id, locale, values)
		);

		await recordEvent(db, {
			action: 'document_category.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: parsed.data }
		});

		return { saved: true };
	},

	update: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await updateCategory(db, id, { position: Number(form.get('position') ?? 0) });

		await saveTranslationsFromForm(
			form,
			(values, locale) => {
				const name = String(values.get(`name.${locale}`) ?? '').trim();
				return name ? { name } : null;
			},
			(locale, values) => setCategoryTranslation(db, id, locale, values)
		);

		await recordEvent(db, {
			action: 'document_category.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: clientIp(event) ?? undefined
		});

		return { saved: true };
	},

	remove: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await deleteCategory(db, id);
		await recordEvent(db, {
			action: 'document_category.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: clientIp(event) ?? undefined
		});

		return { saved: true };
	}
};
