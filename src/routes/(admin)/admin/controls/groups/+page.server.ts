import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	createControlGroup,
	deleteControlGroup,
	listControlGroups,
	setControlGroupTranslation,
	updateControlGroup
} from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const load: PageServerLoad = async () => ({ groups: await listControlGroups(getDb()) });

async function saveTranslations(db: ReturnType<typeof getDb>, groupId: string, form: FormData) {
	for (const locale of getConfig().locales) {
		const name = String(form.get(`name.${locale}`) ?? '').trim();
		if (!name) continue;
		await setControlGroupTranslation(db, groupId, locale, {
			name,
			description: String(form.get(`description.${locale}`) ?? '').trim() || null
		});
	}
}

export const actions: Actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		const id = await createControlGroup(db, {
			slug: parsed.data,
			position: Number(form.get('position') ?? 0)
		});
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
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

		await updateControlGroup(db, id, { position: Number(form.get('position') ?? 0) });
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	},

	remove: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await deleteControlGroup(db, id);
		await recordEvent(db, {
			action: 'control_group.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	}
};
