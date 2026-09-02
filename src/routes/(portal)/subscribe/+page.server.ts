import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { enqueueEmail } from '$lib/server/mail/queue';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { manageTokenFor, subscribe } from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	// A public form, identical for everyone, so it stays cacheable exactly as
	// /request is. The confirm and manage pages are NOT — they carry a token,
	// and spec §10.3 is where that divergence is argued.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { topics: [...UPDATE_KINDS] };
};

type SubscribeFailure = { field: string };

const schema = z.object({
	email: z.string().trim().toLowerCase().email(),
	// Refused here rather than by a constraint: a subscription that matches
	// nothing is a row that exists to send no mail, and would read as a bug
	// from both ends (spec §5).
	topics: z
		.array(z.enum(UPDATE_KINDS))
		.min(1)
		// Deduped here rather than defended in replaceTopics: subscription_topic has
		// a composite primary key, so a repeated value raises 23505 and 500s — and
		// because the `already` path returns before topics are written, that 500
		// would answer "is this address subscribed?" for anyone who asked (P4.4).
		.transform((topics) => [...new Set(topics)])
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = schema.safeParse({
			email: form.get('email'),
			topics: form.getAll('topics').map(String)
		});

		if (!parsed.success) {
			return fail<SubscribeFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'email')
			});
		}

		const db = getDb();
		const config = getConfig();
		const ip = clientIp(event);

		// Two limiters, mirroring /request: the email limiter stops one address
		// being mail-bombed, the ip limiter stops one client enumerating many. A
		// null ip falls back to a shared bucket rather than skipping the check.
		for (const key of [
			rateLimitKey('subscribe:email', parsed.data.email),
			rateLimitKey('subscribe:ip', ip ?? 'unknown')
		]) {
			const limited = await consumeRateLimit(db, { key, limit: 5, windowSeconds: 3600 });
			if (!limited.allowed) return fail<SubscribeFailure>(429, { field: 'throttled' });
		}

		const result = await subscribe(db, {
			email: parsed.data.email,
			locale: event.locals.locale,
			topics: parsed.data.topics,
			ttlMinutes: config.magicLinkTtlMinutes
		});

		if (result.kind === 'already') {
			// Changes nothing and audits nothing (P4.4, P4.17): an unauthenticated
			// caller must not edit — or append audit rows against — a stranger's
			// subscription. The mail is the only trace, and outbound_email holds it.
			// It carries the manage link, which is the recovery path for someone
			// who has lost every mail we sent them.
			//
			// The token is read here rather than returned by `subscribe`, so a
			// stranger's credential never reaches a response body — only their
			// mailbox. A confirmed row always has one (the check constraint says
			// so), but a null must not become the string "null" in a mailed link.
			const token = await manageTokenFor(db, result.subscriptionId);
			if (token) {
				await enqueueEmail(db, {
					to: parsed.data.email,
					template: 'subscription_already',
					locale: event.locals.locale,
					payload: {
						url: `${config.baseUrl}${localizePath(
							`/subscribe/manage?token=${encodeURIComponent(token)}`,
							event.locals.locale
						)}`
					}
				});
			}
			return { submitted: true };
		}

		await enqueueEmail(db, {
			to: parsed.data.email,
			template: 'subscription_confirm',
			locale: event.locals.locale,
			payload: {
				url: `${config.baseUrl}${localizePath(
					`/subscribe/confirm?token=${encodeURIComponent(result.confirmToken)}`,
					event.locals.locale
				)}`
			}
		});

		await recordEvent(db, {
			// `system`, not `subscriber`: nobody has proven they control that
			// address yet, exactly as `access_request.submitted` reasons. The
			// `subscriber` actor starts at confirmation, which is the moment
			// consent becomes a fact worth attributing (spec §10.1).
			actor: { type: 'system', id: null },
			action: 'subscription.requested',
			subjectType: 'subscription',
			subjectId: result.subscriptionId,
			ip: ip ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined,
			// No address and no topic list: spec §10.2 confines subscriber personal
			// data to ip, ua and actor_id. The row itself holds the rest.
			meta: { topicCount: parsed.data.topics.length }
		});

		// Identical in all three cases. This is the enumeration resistance: known
		// address, unknown address and confirmed address all end here.
		return { submitted: true };
	}
};
