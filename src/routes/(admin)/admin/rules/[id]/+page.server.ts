import { error, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { deleteRule, getRule, ruleSchema, updateRule } from '$lib/server/access/rules';
import { saveMetaAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const rule = await getRule(getDb(), params.id);
	if (!rule) error(404, 'Rule not found');
	return { rule };
};

export const actions: Actions = {
	// `access_rule` has no translations and no published state, so this is
	// `saveMetaAction` at its plainest: parse, update, record `access_rule.updated`
	// with the whole rule in `meta`.
	saveMeta: saveMetaAction({
		type: 'access_rule',
		schema: ruleSchema,
		read: (form) => ({
			pattern: form.get('pattern'),
			action: form.get('action'),
			maxTier: form.get('maxTier'),
			priority: form.get('priority') ?? 100,
			note: form.get('note') ?? ''
		}),
		update: (db, id, data) => updateRule(db, id, data),
		fallbackField: 'pattern'
	}),

	remove: async (event) => {
		const db = getDb();
		// Read before the delete: the audit row is the only place a deleted rule
		// survives, and "what did that rule say" is the question asked afterwards.
		const rule = await getRule(db, event.params.id);
		if (!rule) error(404, 'Rule not found');

		await deleteRule(db, event.params.id);

		await recordEvent(db, {
			action: 'access_rule.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_rule',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: {
				pattern: rule.pattern,
				action: rule.action,
				maxTier: rule.maxTier,
				priority: rule.priority,
				note: rule.note
			}
		});

		redirect(303, localizePath('/admin/rules', event.locals.locale));
	}
};
