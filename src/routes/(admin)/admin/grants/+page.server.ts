import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { listGrantsForAdmin, revokeGrant } from '$lib/server/access/grants';
import { groupNames } from '$lib/server/access/groups';
import { recordEvent } from '$lib/server/audit';
import { groupByKey } from '$lib/server/collections';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { accessGrantNda } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { listTemplates } from '$lib/server/nda/templates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const db = getDb();
	const config = getConfig();

	// Independent reads, so they go together: the group names are for the scope
	// summary and have nothing to say about which grants exist.
	const [grants, names, requirements, templates] = await Promise.all([
		listGrantsForAdmin(db),
		groupNames(db, locals.locale),
		// §5.2's second control. Approval already refuses to *create* a
		// requirement nobody could be shown, but a version can stop being
		// renderable afterwards — a locale added to LOCALES, a version retired —
		// and then nothing else in the system would say so: the requester sits on
		// an unavailable page while `acceptance_due_at` ticks down.
		db
			.select({ grantId: accessGrantNda.grantId, templateId: accessGrantNda.ndaTemplateId })
			.from(accessGrantNda)
			.where(eq(accessGrantNda.disposition, 'required')),
		listTemplates(db, config.locales)
	]);

	const blockedById = new Map(
		templates
			.filter((row) => row.effectiveVersionNumber === null)
			.map((row) => [row.id, { names: row.names, slug: row.slug, locales: row.blockedLocales }])
	);

	const blocked = groupByKey(
		requirements.flatMap((row) => {
			const template = blockedById.get(row.templateId);
			return template ? [{ grantId: row.grantId, ...template }] : [];
		}),
		(row) => row.grantId
	);

	return {
		grants: grants.map((grant) => ({ ...grant, blocked: blocked.get(grant.id) ?? [] })),
		groupNames: names
	};
};

const grantId = z.string().uuid();

export const actions: Actions = {
	revoke: async (event) => {
		const form = await event.request.formData();
		const parsed = grantId.safeParse(form.get('grantId'));
		// Validated rather than passed through: an id that is not a uuid reaches
		// Postgres as a cast error and 500s a page that should have said no.
		if (!parsed.success) return fail(400, { failed: true });

		const db = getDb();
		await revokeGrant(db, parsed.data, event.locals.staff!.id);

		// Nothing derived from the requester: spec §10 keeps their personal data
		// out of meta, and the grant id already names the row.
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_grant',
			subjectId: parsed.data,
			ip: clientIp(event) ?? undefined
		});

		return { revoked: true };
	}
};
