import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail } from '@sveltejs/kit';
import { createGroup, groupSchema, listGroups } from '$lib/server/access/groups';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ groups: await listGroups(getDb()) });

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const parsed = groupSchema.safeParse({
			slug: form.get('slug'),
			position: form.get('position') ?? 0
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		let id: string;
		try {
			id = await createGroup(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'slug');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		await recordEvent(db, {
			action: 'access_group.created',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			// Operator configuration, not requester data, so the whole thing belongs
			// in meta — the same reasoning `access_rule.created` records.
			meta: { ...parsed.data }
		});

		return { saved: true };
	}
};
