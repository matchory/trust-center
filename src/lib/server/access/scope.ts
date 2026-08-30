import { asc, eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { SCOPE_TIERS } from '../../access-types';
import { accessGrantGroup, accessGrantTier, accessRequestTier, accessRuleTier } from '../db/schema';
import type { ScopeTier } from '../../access-types';
import type { Db } from '../db';

/**
 * What this phase actually honours. `nda` is storable — the backfill preserves
 * a rule that named it — and is not yet granted, because nothing can record an
 * acceptance until Phase 3b. This constant is the single place that refusal
 * lives, replacing Phase 2's `PHASE_CEILING`, and 3b deletes it.
 */
export const PHASE_TIERS: readonly ScopeTier[] = ['request'];

/** `PHASE_TIERS ⊆ SCOPE_TIERS`, so filtering the phase set is the whole test. */
export function honouredTiers(tiers: readonly string[]): ScopeTier[] {
	return PHASE_TIERS.filter((tier) => tiers.includes(tier));
}

/** Raised when a group cannot be deleted because a grant still names it. */
export class ScopeGroupInUse extends Error {}

/**
 * The four sets are read the same way, so the read is written once. The
 * *writes* are not, and deliberately: Drizzle's `.values()` is keyed by the
 * TypeScript property name (`grantId`), while a `PgColumn` carries the database
 * name (`grant_id`). A generic writer has to build that payload from a column
 * object, which typechecks and then inserts `default` — this exact bug, caught
 * by the round-trip tests rather than the compiler. It is the same hazard
 * `content/translations.ts` names when it refuses to go generic over tables.
 */
async function readSet(
	db: Db,
	table: PgTable,
	owner: PgColumn,
	ownerId: string,
	value: PgColumn
): Promise<string[]> {
	const rows = await db.select({ value }).from(table).where(eq(owner, ownerId)).orderBy(asc(value));

	return rows.map((row) => String(row.value));
}

/**
 * The database CHECK admits only `SCOPE_TIERS`, so this narrows the type rather
 * than filtering: a value it dropped could not have been stored.
 */
function asTiers(values: readonly string[]): ScopeTier[] {
	return values.filter((value): value is ScopeTier =>
		(SCOPE_TIERS as readonly string[]).includes(value)
	);
}

export async function requestTiers(db: Db, requestId: string): Promise<ScopeTier[]> {
	return asTiers(
		await readSet(
			db,
			accessRequestTier,
			accessRequestTier.requestId,
			requestId,
			accessRequestTier.tier
		)
	);
}

export async function grantTiers(db: Db, grantId: string): Promise<ScopeTier[]> {
	return asTiers(
		await readSet(db, accessGrantTier, accessGrantTier.grantId, grantId, accessGrantTier.tier)
	);
}

export function grantGroups(db: Db, grantId: string): Promise<string[]> {
	return readSet(db, accessGrantGroup, accessGrantGroup.grantId, grantId, accessGrantGroup.groupId);
}

export async function ruleTiers(db: Db, ruleId: string): Promise<ScopeTier[]> {
	return asTiers(
		await readSet(db, accessRuleTier, accessRuleTier.ruleId, ruleId, accessRuleTier.tier)
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
 * and silently rewrite it when 3b widened the filter. Every current caller
 * happens to filter first — that is the caller's choice about its own form, not
 * a property of these functions.
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
