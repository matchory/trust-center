import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { localizePath } from '$lib/i18n/locale';
import { RequestRejected, requestableDocuments, submitRequest } from '$lib/server/access/requests';
import { PHASE_TIERS } from '$lib/server/access/scope';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { enqueueEmail } from '$lib/server/mail/queue';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	// The form itself is public and identical for everyone, but it must not be
	// indexed: it is a submission surface, not content.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });

	return {
		documents: await requestableDocuments(getDb(), locals.locale),
		// Only the tiers this phase honours, so the NDA tier is not rendered at
		// all rather than rendered and refused — there is no conditional in the
		// template for somebody to delete.
		tiers: [...PHASE_TIERS]
	};
};

type RequestFailure = { field: string };

const schema = z.object({
	email: z.string().trim().toLowerCase().email(),
	name: z.string().trim().min(1),
	company: z.string().trim().min(1),
	justification: z.string().trim().max(2000).optional()
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = schema.safeParse({
			email: form.get('email'),
			name: form.get('name'),
			company: form.get('company'),
			justification: String(form.get('justification') ?? '').trim() || undefined
		});

		if (!parsed.success) {
			return fail<RequestFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'email')
			});
		}

		const db = getDb();
		const config = getConfig();
		const ip = clientIp(event);

		// Two limiters, deliberately. The email limiter stops one address being
		// mail-bombed; the address limiter stops one client enumerating many. A
		// missing client address must not disable the limiter, so a null ip falls
		// back to a shared bucket rather than skipping the check.
		for (const key of [
			rateLimitKey('request:email', parsed.data.email),
			rateLimitKey('request:ip', ip ?? 'unknown')
		]) {
			const limited = await consumeRateLimit(db, { key, limit: 5, windowSeconds: 3600 });
			if (!limited.allowed) return fail<RequestFailure>(429, { field: 'throttled' });
		}

		const documentIds = form.getAll('documentIds').map(String).filter(Boolean);
		const tiers = form.getAll('tiers').map(String).filter(Boolean);

		try {
			const { requestId, magicLinkToken } = await submitRequest(db, {
				email: parsed.data.email,
				name: parsed.data.name,
				company: parsed.data.company,
				justification: parsed.data.justification ?? null,
				documentIds,
				tiers,
				locale: event.locals.locale,
				linkTtlMinutes: config.magicLinkTtlMinutes
			});

			const url = `${config.baseUrl}${localizePath(
				`/access/verify?token=${encodeURIComponent(magicLinkToken)}`,
				event.locals.locale
			)}`;

			await enqueueEmail(db, {
				to: parsed.data.email,
				template: 'verify_request',
				locale: event.locals.locale,
				payload: { url }
			});

			await recordEvent(db, {
				// Not `requester`: nobody has proven they control that address yet.
				actor: { type: 'system', id: null },
				action: 'access_request.submitted',
				subjectType: 'access_request',
				subjectId: requestId,
				ip: ip ?? undefined,
				ua: event.request.headers.get('user-agent') ?? undefined,
				// No email, name, or company: spec §10 confines requester personal
				// data to ip, ua, and actor_id. The row itself holds the submission.
				meta: {
					documentCount: documentIds.length,
					tiers
				}
			});
		} catch (cause) {
			// A rejected scope is the only expected failure here, and it must not be
			// distinguishable from success: a caller probing for which document ids
			// exist learns nothing either way.
			if (!(cause instanceof RequestRejected)) throw cause;
		}

		// Always the same result, always the same shape. This is spec §9.1's
		// enumeration resistance: known email, unknown email, rejected scope, and
		// accepted scope all end here.
		return { submitted: true };
	}
};
