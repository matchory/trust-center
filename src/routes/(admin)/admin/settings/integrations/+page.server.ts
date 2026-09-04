import { error, fail } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { EGRESS_FORMATS, type EgressFormat } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { createEndpoint, EndpointInvalid, listEndpoints } from '$lib/server/egress/endpoints';
import { parsePatterns } from './patterns';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Admin only, not approver: an endpoint URL is where a prospect's name and
	// address get sent, and §6's threat model is the compromised admin. Same
	// gate, same shape as /admin/audit.
	if (locals.staff?.role !== 'admin') {
		error(403, 'Integrations are restricted to administrators.');
	}

	return {
		endpoints: await listEndpoints(getDb()),
		// So the page can say why nothing is being delivered — a configured
		// endpoint that delivers nothing otherwise looks like a bug.
		egressEnabled: getConfig().egress.enabled
	};
};

export const actions: Actions = {
	create: async (event) => {
		if (event.locals.staff?.role !== 'admin') {
			error(403, 'Integrations are restricted to administrators.');
		}

		const form = await event.request.formData();
		const format = String(form.get('format') ?? '');
		if (!(EGRESS_FORMATS as readonly string[]).includes(format)) {
			return fail(400, { field: 'format' });
		}

		try {
			await createEndpoint(
				getDb(),
				{
					name: String(form.get('name') ?? ''),
					url: String(form.get('url') ?? ''),
					format: format as EgressFormat,
					patterns: parsePatterns(form.get('patterns'))
				},
				{ staffUserId: event.locals.staff.id, ip: clientIp(event) }
			);
		} catch (cause) {
			// A URL the destination rules refuse, or a malformed pattern, is an
			// operator typo — the same `fail(400, { field })` shape
			// /admin/settings/access uses, not a 500.
			if (cause instanceof EndpointInvalid) {
				return fail(400, { field: cause.field, message: cause.message });
			}
			throw cause;
		}

		return { saved: true };
	}
};
