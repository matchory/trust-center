import { asc, eq } from 'drizzle-orm';
import { accessGrantGroup, accessGrantTier, accessRequestTier, accessRuleTier } from '../db/schema';
import type { Db } from '../db';

/** The tiers a scope may name. `public` needs no grant and is not one of them. */
export const SCOPE_TIERS = ['request', 'nda'] as const;
export type ScopeTier = (typeof SCOPE_TIERS)[number];

/**
 * What this phase actually honours. `nda` is storable — the backfill preserves
 * a rule that named it — and is not yet granted, because nothing can record an
 * acceptance until Phase 3b. This constant is the single place that refusal
 * lives, replacing Phase 2's `PHASE_CEILING`, and 3b deletes it.
 */
export const PHASE_TIERS: readonly ScopeTier[] = ['request'];

export function honouredTiers(tiers: readonly string[]): ScopeTier[] {
	return SCOPE_TIERS.filter((tier) => tiers.includes(tier) && PHASE_TIERS.includes(tier));
}

/** Raised when a group cannot be deleted because a grant still names it. */
export class ScopeGroupInUse extends Error {}

function assertTiers(tiers: readonly string[]): ScopeTier[] {
	return tiers.filter((tier): tier is ScopeTier =>
		(SCOPE_TIERS as readonly string[]).includes(tier)
	);
}

/**
 * Every setter replaces wholesale rather than diffing, in one transaction, for
 * the reason `setDocumentGroups` does: a half-applied replacement would leave a
 * scope that is neither what it was nor what was asked for.
 *
 * The setters deliberately do NOT filter through `honouredTiers`. What an
 * operator chose is what gets stored; what this phase grants is decided at read
 * time. Storing the filtered set would lose the operator's intent permanently
 * and silently rewrite it when 3b widened the filter.
 */
export async function setRequestTiers(
	db: Db,
	requestId: string,
	tiers: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessRequestTier).where(eq(accessRequestTier.requestId, requestId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessRequestTier).values(values.map((tier) => ({ requestId, tier })));
	});
}

export async function requestTiers(db: Db, requestId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessRequestTier.tier })
		.from(accessRequestTier)
		.where(eq(accessRequestTier.requestId, requestId))
		.orderBy(asc(accessRequestTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}

export async function setGrantTiers(
	db: Db,
	grantId: string,
	tiers: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessGrantTier).where(eq(accessGrantTier.grantId, grantId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessGrantTier).values(values.map((tier) => ({ grantId, tier })));
	});
}

export async function grantTiers(db: Db, grantId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessGrantTier.tier })
		.from(accessGrantTier)
		.where(eq(accessGrantTier.grantId, grantId))
		.orderBy(asc(accessGrantTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}

export async function setGrantGroups(
	db: Db,
	grantId: string,
	groupIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessGrantGroup).where(eq(accessGrantGroup.grantId, grantId));
		const values = [...new Set(groupIds)];
		if (values.length === 0) return;
		await tx.insert(accessGrantGroup).values(values.map((groupId) => ({ grantId, groupId })));
	});
}

export async function grantGroups(db: Db, grantId: string): Promise<string[]> {
	const rows = await db
		.select({ groupId: accessGrantGroup.groupId })
		.from(accessGrantGroup)
		.where(eq(accessGrantGroup.grantId, grantId));

	return rows.map((row) => row.groupId);
}

export async function setRuleTiers(
	db: Db,
	ruleId: string,
	tiers: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessRuleTier).where(eq(accessRuleTier.ruleId, ruleId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessRuleTier).values(values.map((tier) => ({ ruleId, tier })));
	});
}

export async function ruleTiers(db: Db, ruleId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessRuleTier.tier })
		.from(accessRuleTier)
		.where(eq(accessRuleTier.ruleId, ruleId))
		.orderBy(asc(accessRuleTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}
