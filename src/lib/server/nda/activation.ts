import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accessGrant, accessGrantAcceptance, accessGrantNda, requester } from '../db/schema';
import { groupByKey } from '../collections';
import { validAcceptance } from './acceptance';
import type { AcceptanceScope } from '../../nda-types';
import type { Db } from '../db';

/**
 * The predicate in full (§7.4). "Every requirement satisfied" is not
 * sufficient: three of these clauses exist to stop activation *resurrecting* a
 * grant that ended for some other reason. Each has a named failure it prevents,
 * stated in `tests/unit/nda-activation.test.ts`.
 */
export function isActivatable(
	grant: {
		expiresAt: Date | null;
		revokedAt: Date | null;
		closedAt: Date | null;
		acceptanceDueAt: Date | null;
		required: readonly string[];
	},
	satisfied: ReadonlySet<string>,
	now: Date
): boolean {
	if (grant.expiresAt !== null) return false;
	if (grant.revokedAt !== null) return false;
	if (grant.closedAt !== null) return false;
	if (grant.acceptanceDueAt === null || grant.acceptanceDueAt <= now) return false;

	return grant.required.every((templateId) => satisfied.has(templateId));
}

/**
 * Start the clock on every grant of this requester's whose agreements are now
 * satisfied, and record which acceptance did it.
 *
 * A set operation rather than a per-grant call because one acceptance can
 * activate several grants — a prospect who asked twice before signing once.
 *
 * Called from two places, and the second one *is* §9.9's return-visit fast
 * path: a requester who already holds a valid acceptance has every requirement
 * satisfied the moment `decideRequest` records them, so their grant activates
 * in the same transaction with no second click-through. There is no separate
 * fast-path code to keep in step, which is why §9.9 went two phases without an
 * entry point.
 */
export async function activateGrants(
	db: Db,
	requesterId: string,
	options: { scope: AcceptanceScope; locales: readonly string[]; now?: Date }
): Promise<{ activated: string[] }> {
	const now = options.now ?? new Date();

	const [person] = await db
		.select({ companyDomain: requester.companyDomain })
		.from(requester)
		.where(eq(requester.id, requesterId))
		.limit(1);

	if (!person) return { activated: [] };

	// Only inert grants can activate, so the query asks for exactly those. The
	// rest of the predicate is re-applied in JS, where it is readable and where
	// its unit tests can reach it.
	const grants = await db
		.select({
			id: accessGrant.id,
			grantedAt: accessGrant.grantedAt,
			termDays: accessGrant.termDays,
			expiresAt: accessGrant.expiresAt,
			revokedAt: accessGrant.revokedAt,
			closedAt: accessGrant.closedAt,
			acceptanceDueAt: accessGrant.acceptanceDueAt
		})
		.from(accessGrant)
		.where(and(eq(accessGrant.requesterId, requesterId), isNull(accessGrant.expiresAt)));

	if (grants.length === 0) return { activated: [] };

	const requirementRows = await db
		.select({ grantId: accessGrantNda.grantId, templateId: accessGrantNda.ndaTemplateId })
		.from(accessGrantNda)
		.where(
			and(
				inArray(
					accessGrantNda.grantId,
					grants.map((grant) => grant.id)
				),
				eq(accessGrantNda.disposition, 'required')
			)
		);

	const requiredByGrant = groupByKey(requirementRows, (row) => row.grantId);

	// One lookup per distinct template, not per grant: two inert grants of the
	// same requester routinely require the same agreement.
	const satisfied = new Set<string>();
	const acceptanceByTemplate = new Map<string, string>();

	for (const templateId of new Set(requirementRows.map((row) => row.templateId))) {
		const held = await validAcceptance(db, {
			requesterId,
			companyDomain: person.companyDomain,
			templateId,
			scope: options.scope,
			locales: options.locales
		});

		if (!held) continue;
		satisfied.add(templateId);
		acceptanceByTemplate.set(templateId, held.acceptanceId);
	}

	const activatable = grants
		.map((grant) => ({
			...grant,
			required: (requiredByGrant.get(grant.id) ?? []).map((row) => row.templateId)
		}))
		.filter((grant) => isActivatable(grant, satisfied, now));

	if (activatable.length === 0) return { activated: [] };

	await db.transaction(async (tx) => {
		for (const grant of activatable) {
			// The clock starts now, not at approval: a prospect who took a week to
			// read the agreement does not lose a week of access (P3.1).
			await tx
				.update(accessGrant)
				.set({
					expiresAt: new Date(now.getTime() + grant.termDays * 86_400_000),
					acceptanceDueAt: null
				})
				// Re-stated rather than trusted from the read above: two concurrent
				// activations of the same grant must not both write a clock.
				.where(and(eq(accessGrant.id, grant.id), isNull(accessGrant.expiresAt)));

			const acceptanceIds = [
				...new Set(
					grant.required.flatMap((templateId) => {
						const acceptanceId = acceptanceByTemplate.get(templateId);
						return acceptanceId ? [acceptanceId] : [];
					})
				)
			];

			if (acceptanceIds.length === 0) continue;

			// Which acceptance activated which grant is a fact about *this*
			// activation, not about the acceptance — a grant may activate months
			// after the acceptance it relies on (§12 deviation 11).
			await tx
				.insert(accessGrantAcceptance)
				.values(acceptanceIds.map((acceptanceId) => ({ grantId: grant.id, acceptanceId })))
				.onConflictDoNothing();
		}
	});

	return { activated: activatable.map((grant) => grant.id) };
}
