import { and, eq, isNull, inArray } from 'drizzle-orm';
import {
	accessGrant,
	accessGrantNda,
	accessRule,
	accessRuleTier,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateTranslation,
	ndaTemplateVersion,
	requester
} from '../db/schema';
import { matchRule } from '../access/rules';
import { groupByKey } from '../collections';
import { effectiveVersion } from './templates';
import type { EffectiveVersion } from './templates';
import type { AccessRuleAction, ScopeTier } from '../../access-types';
import type { AcceptanceScope } from '../../nda-types';
import type { Db } from '../db';

/**
 * Raised when the version the form rendered is no longer the one a requester
 * would be shown, or its bytes changed underneath them.
 *
 * Without this, a version published while somebody is reading produces a record
 * whose `template_sha256` pins bytes the signatory demonstrably never saw — a
 * hash that lies with the full authority of the record. The
 * `(requester_id, version_id)` constraint gives no protection: a stale version
 * is a different row and inserts cleanly.
 */
export class VersionMoved extends Error {}

export interface AcceptanceInput {
	requesterId: string;
	versionId: string;
	typedName: string;
	/** The hash of the body the form rendered, carried back from the page. */
	sha256: string;
	ip: string | null;
	ua: string | null;
	/**
	 * The enabled locales. An argument rather than a `getConfig()` call, and not
	 * optional: what counts as *the* effective version depends on which locales
	 * must be complete, so a check made without them could refuse the very
	 * version the page rendered.
	 */
	locales: readonly string[];
}

/**
 * §6.1. One transaction: re-read what is effective, refuse anything else, copy
 * the requester's identity onto the row, insert idempotently, and freeze the
 * version.
 *
 * The identity columns are copied rather than joined, for the reason the schema
 * gives: `purgeRequester` blanks them, and a record that keeps a typed name
 * while losing the email holds personal data it can no longer attach to a
 * contracting party.
 */
export async function recordAcceptance(
	db: Db,
	input: AcceptanceInput
): Promise<{ acceptanceId: string; created: boolean; effective: EffectiveVersion }> {
	return db.transaction(async (tx) => {
		const [version] = await tx
			.select({ templateId: ndaTemplateVersion.templateId })
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.id, input.versionId))
			.limit(1);

		if (!version) throw new VersionMoved('no such version');

		// Re-derived inside the transaction rather than trusted from the form,
		// and through the same function the page rendered from — a second,
		// simpler "is it published" test here would disagree with the page the
		// moment a newer version stopped being locale-complete.
		const effective = await effectiveVersion(tx, version.templateId, input.locales);

		if (!effective || effective.versionId !== input.versionId) {
			throw new VersionMoved('a newer version is now in force');
		}

		// The hash is the whole point of the record, so it is matched against the
		// stored bytes rather than stored as whatever the form sent.
		const rendered = Object.values(effective.bodies).some((body) => body.sha256 === input.sha256);
		if (!rendered) throw new VersionMoved('the body changed while it was being read');

		const [person] = await tx
			.select({
				email: requester.email,
				company: requester.company,
				companyDomain: requester.companyDomain
			})
			.from(requester)
			.where(eq(requester.id, input.requesterId))
			.limit(1);

		if (!person) throw new Error('no such requester');

		const [inserted] = await tx
			.insert(ndaAcceptance)
			.values({
				requesterId: input.requesterId,
				versionId: input.versionId,
				typedName: input.typedName,
				templateSha256: input.sha256,
				ip: input.ip,
				ua: input.ua,
				email: person.email,
				company: person.company,
				companyDomain: person.companyDomain
			})
			// A double submit is the same acceptance, not a second one.
			.onConflictDoNothing({
				target: [ndaAcceptance.requesterId, ndaAcceptance.versionId]
			})
			.returning({ id: ndaAcceptance.id });

		if (!inserted) {
			const [existing] = await tx
				.select({ id: ndaAcceptance.id })
				.from(ndaAcceptance)
				.where(
					and(
						eq(ndaAcceptance.requesterId, input.requesterId),
						eq(ndaAcceptance.versionId, input.versionId)
					)
				)
				.limit(1);

			if (!existing) throw new Error('conflicting acceptance vanished');
			return { acceptanceId: existing.id, created: false, effective };
		}

		// Stamped once. `first_accepted_at` is the immutability marker, and
		// moving it on a later acceptance would misdate when the version froze.
		await tx
			.update(ndaTemplateVersion)
			.set({ firstAcceptedAt: new Date() })
			.where(
				and(eq(ndaTemplateVersion.id, input.versionId), isNull(ndaTemplateVersion.firstAcceptedAt))
			);

		// Returned rather than re-read: this is the version the caller must render
		// the record from, it was resolved and validated here inside the
		// transaction, and asking again outside one invites a different answer.
		return { acceptanceId: inserted.id, created: true, effective };
	});
}

/**
 * Whether this requester is covered for this agreement right now, and by which
 * acceptance. The query §7.4's activation predicate leans on.
 *
 * Under `person` the acceptance must be theirs. Under `domain` a colleague's
 * counts — but only for a domain an `auto_approve` rule matches. Nothing in the
 * schema distinguishes a corporate domain from `gmail.com`, and
 * `decideFromRules` returns `review` for an unmatched domain rather than
 * denying it, so without that bound one hand-approved free-mail requester would
 * satisfy the requirement for an unbounded population (§6.3).
 *
 * It is always the *effective* version that must have been accepted: §6.2 makes
 * a new version a new agreement, and an acceptance of the old one stays a true
 * record of what that person signed without being an acceptance of what the
 * document now requires.
 */
export async function validAcceptance(
	db: Db,
	input: {
		requesterId: string;
		companyDomain: string;
		templateId: string;
		scope: AcceptanceScope;
		locales: readonly string[];
	}
): Promise<{ acceptanceId: string; versionId: string } | null> {
	const effective = await effectiveVersion(db, input.templateId, input.locales);
	if (!effective) return null;

	if (input.scope === 'domain' && !(await domainIsRuleMatched(db, input.companyDomain))) {
		return null;
	}

	const [row] = await db
		.select({ id: ndaAcceptance.id })
		.from(ndaAcceptance)
		.where(
			and(
				eq(ndaAcceptance.versionId, effective.versionId),
				input.scope === 'domain'
					? eq(ndaAcceptance.companyDomain, input.companyDomain)
					: eq(ndaAcceptance.requesterId, input.requesterId)
			)
		)
		.limit(1);

	return row ? { acceptanceId: row.id, versionId: effective.versionId } : null;
}

/**
 * Whether an operator has deliberately said this domain is a company they deal
 * with. `matchRule` rather than a second matcher: two implementations of "which
 * rule wins" drift, and this one gates a widening.
 */
async function domainIsRuleMatched(db: Db, domain: string): Promise<boolean> {
	const rules = await db
		.select({
			id: accessRule.id,
			pattern: accessRule.pattern,
			action: accessRule.action,
			priority: accessRule.priority
		})
		.from(accessRule);

	if (rules.length === 0) return false;

	const tierRows = await db
		.select({ ruleId: accessRuleTier.ruleId, tier: accessRuleTier.tier })
		.from(accessRuleTier);
	const tiersByRule = groupByKey(tierRows, (row) => row.ruleId);

	const matched = matchRule(
		rules.map((rule) => ({
			...rule,
			action: rule.action as AccessRuleAction,
			tiers: (tiersByRule.get(rule.id) ?? []).map((row) => row.tier as ScopeTier)
		})),
		domain
	);

	return matched?.action === 'auto_approve';
}

export interface OutstandingAgreement {
	templateId: string;
	slug: string;
	name: string | null;
	description: string | null;
}

/**
 * What this requester still owes: every agreement a live grant of theirs
 * records as `required` and which they hold no valid acceptance of. The
 * click-through's list, and the acceptance nudge's count.
 *
 * Waived rows are not here by construction — the disposition filter is the
 * whole of the bypass, which is why §7.3 needs the waiver recorded rather than
 * omitted.
 */
export async function outstandingAgreements(
	db: Db,
	requesterId: string,
	options: {
		/** The enabled set, which decides which version is effective. */
		locales: readonly string[];
		/** The one to name the agreements in — the reader's, not the operator's. */
		locale: string;
		scope: AcceptanceScope;
	}
): Promise<OutstandingAgreement[]> {
	const [person] = await db
		.select({ companyDomain: requester.companyDomain })
		.from(requester)
		.where(eq(requester.id, requesterId))
		.limit(1);

	if (!person) return [];

	const required = await db
		.selectDistinct({ templateId: accessGrantNda.ndaTemplateId })
		.from(accessGrantNda)
		.innerJoin(accessGrant, eq(accessGrant.id, accessGrantNda.grantId))
		.where(
			and(
				eq(accessGrant.requesterId, requesterId),
				eq(accessGrantNda.disposition, 'required'),
				// A revoked grant is over; nobody owes an agreement for it.
				isNull(accessGrant.revokedAt)
			)
		);

	if (required.length === 0) return [];

	const names = await db
		.select()
		.from(ndaTemplateTranslation)
		.where(
			inArray(
				ndaTemplateTranslation.templateId,
				required.map((row) => row.templateId)
			)
		);

	const slugs = new Map(
		(
			await db
				.select({ id: ndaTemplate.id, slug: ndaTemplate.slug })
				.from(ndaTemplate)
				.where(
					inArray(
						ndaTemplate.id,
						required.map((row) => row.templateId)
					)
				)
		).map((row) => [row.id, row.slug])
	);

	const byTemplate = groupByKey(names, (row) => row.templateId);
	const outstanding: OutstandingAgreement[] = [];

	// One `validAcceptance` per template rather than one query: the set is what
	// this one requester's grants name, which is small, and the alternative is a
	// second SQL expression of the rule `validAcceptance` already owns.
	for (const row of required) {
		const held = await validAcceptance(db, {
			requesterId,
			companyDomain: person.companyDomain,
			templateId: row.templateId,
			scope: options.scope,
			locales: options.locales
		});
		if (held) continue;

		const translations = byTemplate.get(row.templateId) ?? [];
		const translation =
			translations.find((entry) => entry.locale === options.locale) ?? translations[0] ?? null;

		outstanding.push({
			templateId: row.templateId,
			slug: slugs.get(row.templateId) ?? row.templateId,
			name: translation?.name ?? null,
			description: translation?.description ?? null
		});
	}

	return outstanding;
}
