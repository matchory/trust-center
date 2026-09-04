import { fail } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { EGRESS_FORMATS } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { createEndpoint, EndpointInvalid, listEndpoints } from '$lib/server/egress/endpoints';
import { requireAdmin } from './guard';
import { parsePatterns } from './patterns';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);

	return {
		endpoints: await listEndpoints(getDb()),
		// The same list the edit page renders, so the create form's options come
		// from the enum rather than being spelled out in markup — a format added
		// to the enum but not to the dropdown is one nothing can select.
		formats: EGRESS_FORMATS,
		// So the page can say why nothing is being delivered — a configured
		// endpoint that delivers nothing otherwise looks like a bug.
		egressEnabled: getConfig().egress.enabled
	};
};

export const actions: Actions = {
	create: async (event) => {
		const staff = requireAdmin(event.locals);
		const form = await event.request.formData();

		try {
			await createEndpoint(
				getDb(),
				{
					name: String(form.get('name') ?? ''),
					url: String(form.get('url') ?? ''),
					// Not narrowed here: `validate()` owns the format rule and already
					// throws `EndpointInvalid(…, 'format')`, which the catch below turns
					// into exactly the `fail` a route-level check would have returned.
					format: String(form.get('format') ?? ''),
					patterns: parsePatterns(form.get('patterns'))
				},
				{ staffUserId: staff.id, ip: clientIp(event) }
			);
		} catch (cause) {
			// A URL the destination rules refuse, or a malformed pattern, is an
			// operator typo — the same `fail(400, { field })` shape
			// /admin/settings/access uses, not a 500.
			if (cause instanceof EndpointInvalid) {
				return fail(400, { field: cause.field });
			}
			throw cause;
		}

		return { saved: true };
	}
};
