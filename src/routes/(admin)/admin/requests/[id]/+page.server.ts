import { error, fail } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import {
	decideRequest,
	DecisionRejected,
	getRequestForAdmin,
	requestableDocuments,
	type Decision
} from '$lib/server/access/requests';
import { defaultGrantDays } from '$lib/server/access/grants';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { issueMagicLink } from '$lib/server/identity/magic-link';
import { enqueueEmail } from '$lib/server/mail/queue';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const db = getDb();
	const request = await getRequestForAdmin(db, params.id);
	if (!request) error(404, 'Not found');

	return {
		request,
		// The full list, not just what was asked for: §9.4 lets an approver
		// narrow *or* widen.
		documents: await requestableDocuments(db, locals.locale)
	};
};

type DecisionFailure = { failed: true };

/**
 * The mail a decision produces carries a `sign_in` magic link rather than a
 * bare portal URL. By the time a human decides, the requester's session from
 * verification is long gone, and a link to a page that bounces them to the
 * request form is not a notification of approval.
 */
async function notifyRequester(
	requesterId: string,
	email: string,
	locale: string,
	template: 'request_approved' | 'request_denied',
	payload: { documentCount: number; expiresAt: string; reason: string }
): Promise<void> {
	const db = getDb();
	const config = getConfig();

	const { token } = await issueMagicLink(db, {
		purpose: 'sign_in',
		requesterId,
		ttlMinutes: config.magicLinkTtlMinutes
	});

	const url = `${config.baseUrl}${localizePath(
		`/access/verify?token=${encodeURIComponent(token)}`,
		locale
	)}`;

	await enqueueEmail(db, {
		to: email,
		template,
		// The requester's locale, recorded at verification — not the operator's.
		// A German prospect who used the German portal must not get English mail.
		locale,
		payload: { url, ...payload }
	});
}

async function decide(event: Parameters<Actions[string]>[0], decision: Decision) {
	const db = getDb();
	const config = getConfig();
	const staff = event.locals.staff;
	if (!staff) error(403, 'Forbidden');

	const request = await getRequestForAdmin(db, event.params.id);
	if (!request) error(404, 'Not found');

	const form = await event.request.formData();
	const reason = String(form.get('reason') ?? '').trim() || null;
	const expiresRaw = String(form.get('expiresAt') ?? '').trim();
	const expiresAt = expiresRaw ? new Date(expiresRaw) : null;

	if (expiresAt && Number.isNaN(expiresAt.getTime())) {
		return fail<DecisionFailure>(400, { failed: true });
	}

	const documentIds = form.getAll('documentIds').map(String).filter(Boolean);
	const allRequestTier = form.get('allRequestTier') === 'on';

	// The form still posts an absolute date; Task 8 replaces it with a term in
	// days and adds the tier and group pickers. Until then the term is derived
	// from whatever date was posted, or the configured default.
	const defaultTtlDays = await defaultGrantDays(db, config.accessGrantDefaultDays);
	const termDays = expiresAt
		? Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
		: defaultTtlDays;

	let outcome;
	try {
		outcome = await decideRequest(db, {
			requestId: request.id,
			staffUserId: staff.id,
			decision,
			documentIds,
			tiers: allRequestTier ? ['request'] : [],
			groupIds: [],
			termDays,
			reason
		});
	} catch (cause) {
		// A race with another approver, or a scope naming something out of
		// bounds. Both are the operator's to see, unlike a submission rejection.
		if (cause instanceof DecisionRejected) return fail<DecisionFailure>(409, { failed: true });
		throw cause;
	}

	await recordEvent(db, {
		action: `access_request.${outcome.status}`,
		actor: { type: 'staff', id: staff.id },
		subjectType: 'access_request',
		subjectId: request.id,
		ip: clientIp(event) ?? undefined,
		ua: event.request.headers.get('user-agent') ?? undefined,
		// No email, name, or company: spec §10 keeps requester personal data out
		// of meta. The domain is the company's, and it is what rules match on.
		meta: {
			domain: request.companyDomain,
			grantId: outcome.grantId,
			allRequestTier,
			documentCount: documentIds.length
		}
	});

	// `info_requested` is a question, not a decision, and this phase has no
	// template for it — the operator follows up out of band.
	if (outcome.status === 'approved' || outcome.status === 'denied') {
		await notifyRequester(
			request.requesterId,
			request.email,
			request.requesterLocale,
			outcome.status === 'approved' ? 'request_approved' : 'request_denied',
			{
				documentCount: allRequestTier ? 0 : documentIds.length,
				expiresAt: expiresAt ? expiresAt.toISOString().slice(0, 10) : '',
				reason: reason ?? ''
			}
		);
	}
}

export const actions: Actions = {
	approve: (event) => decide(event, 'approve'),
	deny: (event) => decide(event, 'deny'),
	requestInfo: (event) => decide(event, 'request_info')
};
