import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { defaultGrantDays, setDefaultGrantDays } from '$lib/server/access/grants';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { listTemplates } from '$lib/server/nda/templates';
import {
	ACCEPTANCE_SCOPES,
	acceptanceDueDays,
	acceptanceScope,
	defaultTemplateId,
	setAcceptanceDueDays,
	setAcceptanceScope,
	setDefaultTemplateId
} from '$lib/server/nda/settings';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const config = getConfig();
	const db = getDb();

	const [grantDefaultDays, template, scope, dueDays, templates] = await Promise.all([
		defaultGrantDays(db, config.accessGrantDefaultDays),
		defaultTemplateId(db),
		acceptanceScope(db),
		acceptanceDueDays(db, config.ndaAcceptanceDueDays),
		listTemplates(db, config.locales)
	]);

	return {
		grantDefaultDays,
		envDefault: config.accessGrantDefaultDays,
		defaultTemplateId: template,
		acceptanceScope: scope,
		acceptanceDueDays: dueDays,
		acceptanceDueDaysEnvDefault: config.ndaAcceptanceDueDays,
		templates
	};
};

const days = z.coerce.number().int().positive().max(3650);
const templateIdField = z.preprocess(
	(value) => (value === '' ? null : value),
	z.string().uuid().nullable()
);
const scopeField = z.enum(ACCEPTANCE_SCOPES);

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();

		const grantDefaultDays = days.safeParse(form.get('grantDefaultDays'));
		if (!grantDefaultDays.success) return fail(400, { field: 'grantDefaultDays' });

		const parsedTemplateId = templateIdField.safeParse(form.get('defaultTemplateId'));
		if (!parsedTemplateId.success) return fail(400, { field: 'defaultTemplateId' });

		const parsedScope = scopeField.safeParse(form.get('acceptanceScope'));
		if (!parsedScope.success) return fail(400, { field: 'acceptanceScope' });

		const parsedDueDays = days.safeParse(form.get('acceptanceDueDays'));
		if (!parsedDueDays.success) return fail(400, { field: 'acceptanceDueDays' });

		const db = getDb();
		await setDefaultGrantDays(db, grantDefaultDays.data);
		await setDefaultTemplateId(db, parsedTemplateId.data);
		await setAcceptanceScope(db, parsedScope.data);
		await setAcceptanceDueDays(db, parsedDueDays.data);

		// The values themselves, unlike branding's field-names-only rule: this is
		// operator configuration, and "what did this deployment require, and for
		// how long" is a question the log should be able to answer.
		await recordEvent(db, {
			action: 'settings.access.updated',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'setting',
			subjectId: 'access',
			ip: clientIp(event) ?? undefined,
			meta: {
				grantDefaultDays: grantDefaultDays.data,
				defaultTemplateId: parsedTemplateId.data,
				acceptanceScope: parsedScope.data,
				acceptanceDueDays: parsedDueDays.data
			}
		});

		return { saved: true };
	}
};
