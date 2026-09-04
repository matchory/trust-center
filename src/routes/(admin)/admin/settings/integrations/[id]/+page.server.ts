import { error, fail, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { EGRESS_FORMATS } from '$lib/server/db/schema';
import {
	actionRates,
	bumpSecretVersion,
	deleteEndpoint,
	EndpointInvalid,
	getEndpoint,
	HIGH_FREQUENCY_WEEKLY_EVENTS,
	highFrequencyPatterns,
	revealEndpointSecret,
	sendTestEvent,
	setEndpointEnabled,
	updateEndpoint
} from '$lib/server/egress/endpoints';
import { clientIp } from '$lib/server/http/client-ip';
import { requireAdmin } from '../guard';
import { parsePatterns } from '../patterns';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

function actor(event: RequestEvent) {
	return { staffUserId: requireAdmin(event.locals).id, ip: clientIp(event) };
}

/**
 * Every action on this page addresses an endpoint by id, and each function
 * they call throws `EndpointInvalid(…, 'id')` when the row is gone — a second
 * tab having deleted it is how that happens in practice. Uncaught, that
 * reaches SvelteKit's default handler as a 500, which tells the operator
 * nothing and contradicts the 404 this route's own `load` gives for exactly
 * the same condition. `fail(400, { field: 'id' })` would be wrong too: 'id' is
 * not a form field, so the page would render it as the name error.
 */
async function onExistingEndpoint<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (cause) {
		if (cause instanceof EndpointInvalid && cause.field === 'id') {
			error(404, 'Endpoint not found');
		}
		throw cause;
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdmin(locals);

	const db = getDb();
	const endpoint = await getEndpoint(db, params.id);
	if (!endpoint) error(404, 'Endpoint not found');

	// `document.downloaded` is registered and deliberately not throttled: one
	// grant holder working through forty documents produces forty cards.
	// Throttling it here would be this subsystem deciding what an operator's
	// channel should contain, so the operator chooses and is told what they are
	// choosing (spec §9.1).
	const highFrequency = highFrequencyPatterns(endpoint.patterns, await actionRates(db));

	return {
		endpoint,
		formats: EGRESS_FORMATS,
		highFrequency,
		threshold: HIGH_FREQUENCY_WEEKLY_EVENTS,
		egressEnabled: getConfig().egress.enabled,
		signingKeyConfigured: getConfig().egress.signingKey !== undefined
	};
};

export const actions: Actions = {
	save: async (event) => {
		const who = actor(event);
		const form = await event.request.formData();

		try {
			await onExistingEndpoint(() =>
				updateEndpoint(
					getDb(),
					event.params.id,
					{
						name: String(form.get('name') ?? ''),
						url: String(form.get('url') ?? ''),
						// Unnarrowed on purpose: `updateEndpoint`'s `validate` owns the
						// format rule and reports it through the same `field` as the rest.
						format: String(form.get('format') ?? ''),
						patterns: parsePatterns(form.get('patterns'))
					},
					who
				)
			);
		} catch (cause) {
			if (cause instanceof EndpointInvalid) {
				return fail(400, { field: cause.field });
			}
			throw cause;
		}

		return { saved: true };
	},

	enable: async (event) => {
		const who = actor(event);
		const form = await event.request.formData();
		// Skipping is the option the UI offers first: a channel flooded with a
		// day of stale notices is worse than a gap, and audit_event remains the
		// record of record under either choice (spec §5.5).
		const skipBacklog = form.get('skipBacklog') === 'true';
		await onExistingEndpoint(() =>
			setEndpointEnabled(getDb(), event.params.id, { enabled: true, skipBacklog }, who)
		);
		return { saved: true };
	},

	disable: async (event) => {
		const who = actor(event);
		const form = await event.request.formData();
		await onExistingEndpoint(() =>
			setEndpointEnabled(
				getDb(),
				event.params.id,
				{ enabled: false, reason: String(form.get('reason') ?? '') },
				who
			)
		);
		return { saved: true };
	},

	rotate: async (event) => {
		const who = actor(event);
		const secretVersion = await onExistingEndpoint(() =>
			bumpSecretVersion(getDb(), event.params.id, who)
		);
		return { secretVersion };
	},

	/**
	 * Deliberately an action rather than part of `load`. The gate is the same
	 * either way, but a live HMAC secret in every SSR payload of this page would
	 * sit in the HTML of every back-navigation and every browser cache; the
	 * spec's word is "revealing" (spec §11).
	 */
	reveal: async (event) => {
		requireAdmin(event.locals);
		const outcome = await onExistingEndpoint(() => revealEndpointSecret(getDb(), event.params.id));

		// A missing signing key needs no message of its own: the page already
		// renders `secret_missing` from `load` whenever none is configured, and
		// borrowing the `format` field for it put "choose a supported format"
		// under the save form.
		return 'secret' in outcome ? { secret: outcome.secret } : fail(400, {});
	},

	test: async (event) => {
		requireAdmin(event.locals);
		const outcome = await onExistingEndpoint(() => sendTestEvent(getDb(), event.params.id));
		return { test: outcome };
	},

	delete: async (event) => {
		const who = actor(event);
		// Only the delete is wrapped, never the redirect below it: SvelteKit's
		// `redirect` signals by throwing, so a try/catch around both would
		// swallow the navigation and leave the operator on a deleted endpoint.
		await onExistingEndpoint(() => deleteEndpoint(getDb(), event.params.id, who));
		redirect(303, localizePath('/admin/settings/integrations', event.locals.locale));
	}
};
