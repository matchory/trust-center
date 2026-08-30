import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { defaultGrantDays, setDefaultGrantDays } from '$lib/server/access/grants';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const envDefault = getConfig().accessGrantDefaultDays;
	return { grantDefaultDays: await defaultGrantDays(getDb(), envDefault), envDefault };
};

const days = z.coerce.number().int().positive().max(3650);

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = days.safeParse(form.get('grantDefaultDays'));
		if (!parsed.success) return fail(400, { field: 'grantDefaultDays' });

		const db = getDb();
		await setDefaultGrantDays(db, parsed.data);

		// The value itself, unlike branding's field-names-only rule: a grant term
		// is operator configuration, and "how long did approvals last then" is a
		// question the log should be able to answer.
		await recordEvent(db, {
			action: 'settings.access.updated',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'setting',
			subjectId: 'access',
			ip: clientIp(event) ?? undefined,
			meta: { grantDefaultDays: parsed.data }
		});

		return { saved: true };
	}
};
