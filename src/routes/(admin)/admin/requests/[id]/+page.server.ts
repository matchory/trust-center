import { error, fail } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import {
	decideRequest,
	DecisionRejected,
	getRequestForAdmin,
	requestableDocuments,
	type Decision
} from '$lib/server/access/requests';
import { countGrantDocuments, defaultGrantDays } from '$lib/server/access/grants';
import { listGroups } from '$lib/server/access/groups';
import { PHASE_TIERS } from '$lib/server/access/scope';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import {
	DefaultTemplateMissing,
	proposeRequirements,
	RequirementNotRenderable,
	type RequirementChoice
} from '$lib/server/nda/requirements';
import { acceptanceDueDays, defaultTemplateId } from '$lib/server/nda/settings';
import { listTemplates } from '$lib/server/nda/templates';
import { clientIp } from '$lib/server/http/client-ip';
import { issueMagicLink } from '$lib/server/identity/magic-link';
import { enqueueEmail } from '$lib/server/mail/queue';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const db = getDb();
	const config = getConfig();

	// Independent reads. Awaited in sequence they were one round trip each
	// before this page rendered, and nothing here needs anything else here.
	const [request, documents, groups, defaultTermDays, templates, defaultTemplate] =
		await Promise.all([
			getRequestForAdmin(db, params.id),
			// The full list, not just what was asked for: §9.4 lets an approver
			// narrow *or* widen.
			requestableDocuments(db, locals.locale),
			listGroups(db),
			defaultGrantDays(db, config.accessGrantDefaultDays),
			// For the names, so the requirement list reads as agreements rather
			// than as uuids.
			listTemplates(db, config.locales),
			defaultTemplateId(db)
		]);

	if (!request) error(404, 'Not found');

	// The proposal is computed for the *requested* scope, so the form arrives
	// pre-filled. The approver may then change the scope; what is stored is only
	// ever the set they confirmed (P3.9), and §7.3's live check at delivery is
	// what catches a scope widened past it.
	let proposed: string[] = [];
	let noDefaultAgreement = false;

	try {
		proposed = await proposeRequirements(
			db,
			{ documentIds: request.requestedDocumentIds, tiers: request.tiers, groupIds: [] },
			{ defaultTemplateId: defaultTemplate }
		);
	} catch (cause) {
		// An operator's configuration gap, not a server fault: an nda-tier
		// document is in scope and nobody has said which agreement covers it.
		// The page says so; it does not 500.
		if (!(cause instanceof DefaultTemplateMissing)) throw cause;
		noDefaultAgreement = true;
	}

	return {
		request,
		documents,
		groups,
		tiers: [...PHASE_TIERS],
		defaultTermDays,
		templates,
		proposed,
		noDefaultAgreement
	};
};

type DecisionFailure = { failed: true; unrenderable?: true };

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
	template: 'request_approved' | 'request_acceptance_required' | 'request_denied',
	payload: { documentCount: number; agreementCount: number; expiresAt: string; reason: string }
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

	// A term in days, not an absolute date. In Phase 3b a grant's clock starts
	// at acceptance rather than at approval, and a date chosen today would land
	// wherever that happened to fall; days is also the unit the default setting
	// is already stored in.
	const termRaw = String(form.get('termDays') ?? '').trim();
	const termDays = termRaw
		? Number(termRaw)
		: await defaultGrantDays(db, config.accessGrantDefaultDays);

	if (!Number.isInteger(termDays) || termDays < 1 || termDays > 3650) {
		return fail<DecisionFailure>(400, { failed: true });
	}

	const documentIds = form.getAll('documentIds').map(String).filter(Boolean);
	const tiers = form.getAll('tiers').map(String).filter(Boolean);
	const groupIds = form.getAll('groupIds').map(String).filter(Boolean);

	// Two fields rather than one `templateId:disposition` pair per row: an
	// unchecked checkbox posts nothing, so a single field would need a hidden
	// twin per row and a rule for which of the two wins. `requirements` is the
	// set the approver confirmed applies; `waived` is the subset they excused.
	const waived = new Set(form.getAll('waived').map(String));
	const requirements: RequirementChoice[] = [
		...new Set(form.getAll('requirements').map(String).filter(Boolean))
	].map((templateId) => ({
		templateId,
		disposition: waived.has(templateId) ? 'waived' : 'required',
		reason: String(form.get(`reason.${templateId}`) ?? '').trim() || null
	}));

	let outcome;
	try {
		outcome = await decideRequest(db, {
			requestId: request.id,
			staffUserId: staff.id,
			decision,
			documentIds,
			tiers,
			groupIds,
			termDays,
			reason,
			requirements,
			acceptanceDueDays: await acceptanceDueDays(db, config.ndaAcceptanceDueDays),
			locales: config.locales
		});
	} catch (cause) {
		// A race with another approver, or a scope naming something out of
		// bounds. Both are the operator's to see, unlike a submission rejection.
		if (cause instanceof DecisionRejected) return fail<DecisionFailure>(409, { failed: true });
		// An agreement nobody could be shown. §5.2: the failure lands here, where
		// a person is present, rather than at the click-through where one is not.
		if (cause instanceof RequirementNotRenderable) {
			return fail<DecisionFailure>(409, { failed: true, unrenderable: true });
		}
		throw cause;
	}

	const outstanding = requirements.filter((entry) => entry.disposition === 'required');

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
			tiers,
			groupIds,
			termDays,
			documentCount: documentIds.length,
			// Which agreements were required and which excused is the part of a
			// decision an auditor asks about. Template ids are the company's own
			// objects, not the requester's data.
			requirements: requirements.map((entry) => `${entry.templateId}:${entry.disposition}`)
		}
	});

	// `info_requested` is a question, not a decision, and this phase has no
	// template for it — the operator follows up out of band.
	if (outcome.status === 'approved' || outcome.status === 'denied') {
		// An approval with something outstanding is not "your access is ready" —
		// the requester's next step is an agreement, and the mail has to say so.
		const template =
			outcome.status === 'denied'
				? 'request_denied'
				: outstanding.length > 0
					? 'request_acceptance_required'
					: 'request_approved';

		await notifyRequester(request.requesterId, request.email, request.requesterLocale, template, {
			// What the grant actually covers, asked of the grant. The form's
			// document list is only one of three scope sources now, so counting
			// it here would tell a requester granted a tier or a group that they
			// have nothing.
			//
			// An inert grant confers nothing yet — `countGrantDocuments` filters
			// `expires_at > now()` — so what it *will* cover is counted from the
			// form's own scope instead of reporting zero.
			documentCount:
				outcome.grantId && outstanding.length === 0
					? await countGrantDocuments(db, outcome.grantId)
					: documentIds.length,
			agreementCount: outstanding.length,
			// Only meaningful for a grant whose clock has started; the
			// acceptance-required body does not render it.
			expiresAt: new Date(Date.now() + termDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
			reason: reason ?? ''
		});
	}
}

export const actions: Actions = {
	approve: (event) => decide(event, 'approve'),
	deny: (event) => decide(event, 'deny'),
	requestInfo: (event) => decide(event, 'request_info')
};
