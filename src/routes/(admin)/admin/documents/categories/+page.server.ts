import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	createCategory,
	deleteCategory,
	listCategories,
	setCategoryTranslation,
	updateCategory
} from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.min(1)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug');

export const load: PageServerLoad = async () => ({ categories: await listCategories(getDb()) });

export const actions: Actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		const id = await createCategory(db, {
			slug: parsed.data,
			position: Number(form.get('position') ?? 0)
		});

		for (const locale of getConfig().locales) {
			const name = String(form.get(`name.${locale}`) ?? '').trim();
			if (name) await setCategoryTranslation(db, id, locale, { name });
		}

		await recordEvent(db, {
			action: 'document_category.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data }
		});

		return { saved: true };
	},

	update: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await updateCategory(db, id, { position: Number(form.get('position') ?? 0) });

		for (const locale of getConfig().locales) {
			const name = String(form.get(`name.${locale}`) ?? '').trim();
			if (name) await setCategoryTranslation(db, id, locale, { name });
		}

		await recordEvent(db, {
			action: 'document_category.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	},

	remove: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await deleteCategory(db, id);
		await recordEvent(db, {
			action: 'document_category.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	}
};
