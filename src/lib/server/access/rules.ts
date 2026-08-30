import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ACCESS_RULE_ACTIONS, SCOPE_TIERS } from '../../access-types';
import { groupByKey } from '../collections';
import { accessRule, accessRuleTier } from '../db/schema';
import { honouredTiers, ruleTiers, setRuleTiers } from './scope';
import type { AccessRuleAction, ScopeTier } from '../../access-types';
import type { Db } from '../db';

export interface RuleForMatching {
	id: string;
	pattern: string;
	action: AccessRuleAction;
	tiers: ScopeTier[];
	priority: number;
}

/**
 * The shape `patternMatches` understands: an exact domain, or one leading `*.`.
 * Enforced when a rule is entered, so a pattern that could never match anything
 * is rejected at the form rather than discovered at decision time.
 */
export const RULE_PATTERN =
	/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * An exact domain, or one leading `*.` matching any non-empty subdomain prefix.
 * The bare domain does not match its own wildcard: an operator who wants both
 * writes both rules. Inferring it would silently widen `*.acme.example` to
 * include `acme.example`, which is a different decision than the one written.
 */
export function patternMatches(pattern: string, domain: string): boolean {
	const p = pattern.trim().toLowerCase();
	const d = domain.trim().toLowerCase();

	if (!p || !d) return false;
	if (!p.startsWith('*.')) return p === d;

	// ".acme.example" — the leading dot is what stops `evilacme.example` from
	// matching `*.acme.example` as a plain suffix would.
	const suffix = p.slice(1);
	return d.length > suffix.length && d.endsWith(suffix);
}

/**
 * Lower priority first; a tie goes to the more specific pattern, measured as
 * "an exact match beats a wildcard, then the longer pattern wins". Without a
 * total order the outcome depends on row order, which nobody decided and which
 * would change under an unrelated reindex.
 */
export function matchRule(
	rules: readonly RuleForMatching[],
	domain: string
): RuleForMatching | null {
	const candidates = rules.filter((rule) => patternMatches(rule.pattern, domain));
	if (candidates.length === 0) return null;

	return candidates.reduce((best, rule) => {
		if (rule.priority !== best.priority) return rule.priority < best.priority ? rule : best;

		const bestWild = best.pattern.startsWith('*.');
		const ruleWild = rule.pattern.startsWith('*.');
		if (bestWild !== ruleWild) return ruleWild ? best : rule;

		return rule.pattern.length > best.pattern.length ? rule : best;
	});
}

export interface RuleDecision {
	action: AccessRuleAction;
	/** The blanket tiers this decision may grant. Empty means explicit documents only. */
	tiers: ScopeTier[];
	ruleId: string | null;
}

export function decideFromRules(rules: readonly RuleForMatching[], domain: string): RuleDecision {
	const matched = matchRule(rules, domain);

	// No rule is not an error and not an approval. An unknown domain reaches a
	// human, which is spec §9.3's "everything else becomes pending" — and it
	// carries no blanket, because nothing decided one.
	if (!matched) return { action: 'review', tiers: [], ruleId: null };

	return {
		action: matched.action,
		// A rule may name `nda` — the table admits it and the backfill preserved
		// it. `honouredTiers` is the one place this phase refuses to grant it,
		// and Phase 3b deletes that filter rather than hunting for clamps.
		tiers: honouredTiers(matched.tiers),
		ruleId: matched.id
	};
}

export interface AdminRuleRow {
	id: string;
	pattern: string;
	action: AccessRuleAction;
	tiers: ScopeTier[];
	priority: number;
	note: string | null;
	createdAt: Date;
}

/**
 * The values a rule form may set; `id` and `createdAt` are the database's.
 * Shared by the create and edit routes because a rule that is valid on one is
 * valid on the other, and the pattern check is the point of the whole schema:
 * a rule that can never match is rejected at entry rather than discovered at
 * decision time, when a stranger is being handed documents.
 */
export const ruleSchema = z.object({
	pattern: z.string().trim().toLowerCase().regex(RULE_PATTERN),
	action: z.enum(ACCESS_RULE_ACTIONS),
	tiers: z.array(z.enum(SCOPE_TIERS)).default([]),
	priority: z.coerce.number().int().min(0).max(10_000),
	note: z
		.string()
		.trim()
		.max(500)
		.transform((value) => value || null)
		.nullable()
});

export type RuleInput = z.output<typeof ruleSchema>;

/**
 * Listed in the order `matchRule` considers them, so the page reads the way the
 * evaluation runs. The tie-break is more specific than "then by pattern", but
 * showing the priority order is what an operator needs to see.
 */
export async function listRules(db: Db): Promise<AdminRuleRow[]> {
	const rows = await db
		.select()
		.from(accessRule)
		.orderBy(asc(accessRule.priority), asc(accessRule.pattern));

	if (rows.length === 0) return [];

	// One query for every rule's tiers, not one per rule.
	const tierRows = await db
		.select({ ruleId: accessRuleTier.ruleId, tier: accessRuleTier.tier })
		.from(accessRuleTier)
		.where(
			inArray(
				accessRuleTier.ruleId,
				rows.map((row) => row.id)
			)
		)
		.orderBy(asc(accessRuleTier.tier));

	const tiers = groupByKey(tierRows, (row) => row.ruleId);

	return rows.map((row) =>
		toAdminRow(
			row,
			(tiers.get(row.id) ?? []).map((tier) => tier.tier as ScopeTier)
		)
	);
}

export async function getRule(db: Db, id: string): Promise<AdminRuleRow | null> {
	const [row] = await db.select().from(accessRule).where(eq(accessRule.id, id)).limit(1);
	return row ? toAdminRow(row, await ruleTiers(db, id)) : null;
}

function toAdminRow(row: typeof accessRule.$inferSelect, tiers: ScopeTier[]): AdminRuleRow {
	return {
		...row,
		action: row.action as AccessRuleAction,
		tiers
	};
}

export async function createRule(db: Db, input: RuleInput): Promise<string> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessRule)
			.values({
				pattern: input.pattern,
				action: input.action,
				priority: input.priority,
				note: input.note
			})
			.returning({ id: accessRule.id });

		if (!row) throw new Error('failed to create rule');

		await setRuleTiers(tx, row.id, input.tiers);
		return row.id;
	});
}

export async function updateRule(db: Db, id: string, input: RuleInput): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(accessRule)
			.set({
				pattern: input.pattern,
				action: input.action,
				priority: input.priority,
				note: input.note
			})
			.where(eq(accessRule.id, id));

		await setRuleTiers(tx, id, input.tiers);
	});
}

export async function deleteRule(db: Db, id: string): Promise<void> {
	await db.delete(accessRule).where(eq(accessRule.id, id));
}
