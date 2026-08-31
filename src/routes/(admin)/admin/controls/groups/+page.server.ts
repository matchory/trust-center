import { duplicateFail } from '$lib/server/admin/actions';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import {
	createControlGroup,
	deleteControlGroup,
	listControlGroups,
	setControlGroupTranslation,
	updateControlGroup
} from '$lib/server/content/controls';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const load: PageServerLoad = async () => ({ groups: await listControlGroups(getDb()) });

async function saveTranslations(db: ReturnType<typeof getDb>, groupId: string, form: FormData) {
	await saveTranslationsFromForm(
		form,
		(values, locale) => {
			const name = String(values.get(`name.${locale}`) ?? '').trim();
			return name
				? {
						name,
						description: String(values.get(`description.${locale}`) ?? '').trim() || null
					}
				: null;
		},
		(locale, values) => setControlGroupTranslation(db, groupId, locale, values)
	);
}

export const actions: Actions = {
	create: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		let id: string;
		try {
			id = await createControlGroup(db, {
				slug: parsed.data,
				position: Number(form.get('position') ?? 0)
			});
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			return duplicateFail(cause, 'slug');
		}
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
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

		await updateControlGroup(db, id, { position: Number(form.get('position') ?? 0) });
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
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

		await deleteControlGroup(db, id);
		await recordEvent(db, {
			action: 'control_group.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: clientIp(event) ?? undefined
		});

		return { saved: true };
	}
};
