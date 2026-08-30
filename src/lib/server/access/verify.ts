import { eq } from 'drizzle-orm';
import { recordEvent } from '../audit';
import { groupByKey } from '../collections';
import { accessRequest, accessRequestDocument, accessRule, accessRuleTier } from '../db/schema';
import { consumeMagicLink } from '../identity/magic-link';
import { domainOf, upsertRequester } from '../identity/requester';
import { enqueueEmail } from '../mail/queue';
import { createGrant } from './grants';
import { decideFromRules } from './rules';
import { honouredTiers, requestTiers } from './scope';
import type { AccessRequestStatus, AccessRuleAction, ScopeTier } from '../../access-types';
import type { Db } from '../db';

export type VerificationOutcome =
	| { ok: false }
	| {
			ok: true;
			requesterId: string;
			requestId: string;
			status: Extract<AccessRequestStatus, 'pending' | 'approved' | 'denied'>;
			grantId: string | null;
	  };

export interface VerifyRequestInput {
	token: string;
	ip: string | null;
	ua: string | null;
	locale: string;
	/** How long an auto-approved grant lasts. Passed in; see `createGrant`. */
	grantTtlDays: number;
	/**
	 * Where "a new request is waiting for triage" goes (spec §11). Null when the
	 * deployment watches the queue directly — an unset address must never fail a
	 * verification.
	 */
	staffNotification?: { to: string; locale: string; baseUrl: string } | null;
}

/**
 * The whole of spec §9.2 and §9.3 in one transaction: consume the link, create
 * the identity, adopt the request, evaluate the rules, and — when they allow —
 * mint the grant. All or nothing, because a half-applied verification leaves a
 * request whose `access_request_verification_check` constraint cannot hold.
 *
 * The staff notification is queued *after* the transaction commits. A mail
 * enqueued inside one that later rolls back is a mail about a request that does
 * not exist.
 */
export async function verifyRequest(
	db: Db,
	input: VerifyRequestInput
): Promise<VerificationOutcome> {
	const outcome = await db.transaction(async (tx): Promise<VerificationOutcome> => {
		const link = await consumeMagicLink(tx, input.token, 'verify_request');
		if (!link?.requestId) return { ok: false };

		const [request] = await tx
			.select()
			.from(accessRequest)
			.where(eq(accessRequest.id, link.requestId))
			.limit(1);

		// The sweep job may have deleted it, or it may already be verified.
		if (!request || request.status !== 'unverified' || !request.submittedEmail) {
			return { ok: false };
		}

		const requester = await upsertRequester(tx, {
			email: request.submittedEmail,
			name: request.submittedName ?? '',
			company: request.submittedCompany ?? '',
			locale: input.locale
		});

		const rules = await tx
			.select({
				id: accessRule.id,
				pattern: accessRule.pattern,
				action: accessRule.action,
				priority: accessRule.priority
			})
			.from(accessRule);

		// One query for every rule's tiers rather than one per rule: matching is
		// a read on the verification path, and a rule table is small but not
		// bounded.
		const tierRows = await tx
			.select({ ruleId: accessRuleTier.ruleId, tier: accessRuleTier.tier })
			.from(accessRuleTier);

		const tiersByRule = groupByKey(tierRows, (row) => row.ruleId);

		const decision = decideFromRules(
			rules.map((rule) => ({
				...rule,
				action: rule.action as AccessRuleAction,
				tiers: (tiersByRule.get(rule.id) ?? []).map((row) => row.tier as ScopeTier)
			})),
			domainOf(requester.email)
		);

		const status =
			decision.action === 'auto_approve'
				? 'approved'
				: decision.action === 'deny'
					? 'denied'
					: 'pending';

		// Clearing the submitted columns and setting requesterId in the same
		// UPDATE is what satisfies access_request_verification_check.
		await tx
			.update(accessRequest)
			.set({
				requesterId: requester.id,
				status,
				submittedEmail: null,
				submittedName: null,
				submittedCompany: null,
				decidedAt: status === 'pending' ? null : new Date(),
				reason: status === 'denied' ? 'Denied by access rule' : null
			})
			.where(eq(accessRequest.id, request.id));

		let grantId: string | null = null;

		if (status === 'approved') {
			const scoped = await tx
				.select({ documentId: accessRequestDocument.documentId })
				.from(accessRequestDocument)
				.where(eq(accessRequestDocument.requestId, request.id));

			const tiers = await requestTiers(tx, request.id);

			({ grantId } = await createGrant(tx, {
				requesterId: requester.id,
				requestId: request.id,
				documentIds: scoped.map((row) => row.documentId),
				tiers: honouredTiers(tiers),
				// An auto-approved decision grants no groups: §10.1 says a pattern
				// match may not hand out a blanket, and in this phase the simplest
				// correct form of that is tiers and explicit documents only.
				groupIds: [],
				expiresAt: new Date(Date.now() + input.grantTtlDays * 24 * 60 * 60 * 1000),
				termDays: input.grantTtlDays
			}));
		}

		await recordEvent(tx, {
			action: `access_request.${status}`,
			// Now attributable: this person has proven they control the address.
			actor: { type: 'requester', id: requester.id },
			subjectType: 'access_request',
			subjectId: request.id,
			ip: input.ip ?? undefined,
			ua: input.ua ?? undefined,
			// The matched rule and the domain, so the decision is reconstructible
			// after the rules change (spec §9's domain-drift case). The domain is
			// the company's, not the person's — a personal address is not what
			// rules match on, and spec §10 keeps the address itself out of meta.
			meta: { ruleId: decision.ruleId, domain: domainOf(requester.email), grantId }
		});

		return { ok: true, requesterId: requester.id, requestId: request.id, status, grantId };
	});

	// `pending` is the only outcome that needs a human, so it is the only one
	// worth waking an operator for.
	if (outcome.ok && outcome.status === 'pending' && input.staffNotification) {
		await enqueueEmail(db, {
			to: input.staffNotification.to,
			template: 'staff_new_request',
			// Rendered in the deployment's default locale: the recipient is the
			// operator, not the requester, and this phase has no per-staff locale.
			locale: input.staffNotification.locale,
			payload: { url: `${input.staffNotification.baseUrl}/admin/requests/${outcome.requestId}` }
		});
	}

	return outcome;
}

/**
 * A sign-in link, issued when staff approve or deny a request: by the time a
 * human decides, the requester's original session is long gone. It mints
 * nothing but an identity — there is no request to adopt and no rule to
 * evaluate, because both already happened at verification.
 *
 * Single-use and purpose-scoped by `consumeMagicLink`, so a `verify_request`
 * token presented here is not consumed by the attempt, and vice versa.
 */
export async function consumeSignInLink(
	db: Db,
	input: { token: string; ip: string | null; ua: string | null }
): Promise<{ requesterId: string } | null> {
	const link = await consumeMagicLink(db, input.token, 'sign_in');
	if (!link?.requesterId) return null;

	await recordEvent(db, {
		action: 'requester.signed_in',
		actor: { type: 'requester', id: link.requesterId },
		subjectType: 'requester',
		subjectId: link.requesterId,
		ip: input.ip ?? undefined,
		ua: input.ua ?? undefined
	});

	return { requesterId: link.requesterId };
}
