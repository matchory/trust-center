import { uniqueViolationField } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
import { fail, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { createRule, ruleSchema } from '$lib/server/access/rules';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = ruleSchema.safeParse({
			pattern: form.get('pattern'),
			action: form.get('action'),
			tiers: form.getAll('tiers').map(String),
			priority: form.get('priority') ?? 100,
			note: form.get('note') ?? ''
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'pattern') });
		}

		const db = getDb();
		let id: string;
		try {
			id = await createRule(db, parsed.data);
		} catch (cause) {
			// A value somebody already used is an operator typo, not a 500.
			const duplicate = uniqueViolationField(cause, 'pattern');
			if (!duplicate) throw cause;
			return fail<AdminActionFailure>(409, duplicate);
		}

		// The whole rule, because a rule decides who gets documents without a
		// human. It is operator configuration rather than requester data, so
		// `meta` is where it belongs.
		await recordEvent(db, {
			action: 'access_rule.created',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_rule',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { ...parsed.data }
		});

		redirect(303, localizePath('/admin/rules', event.locals.locale));
	}
};
