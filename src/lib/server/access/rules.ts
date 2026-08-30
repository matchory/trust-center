import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ACCESS_RULE_ACTIONS } from '../../access-types';
import { DOCUMENT_TIERS } from '../../content-types';
import { accessRule } from '../db/schema';
import type { AccessRuleAction } from '../../access-types';
import type { DocumentTier } from '../../content-types';
import type { Db } from '../db';

export interface RuleForMatching {
	id: string;
	pattern: string;
	action: AccessRuleAction;
	maxTier: string;
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
	maxTier: DocumentTier;
	ruleId: string | null;
}

/** This phase gates the request tier only; Phase 3 raises the ceiling. */
const PHASE_CEILING: DocumentTier = 'request';

export function decideFromRules(rules: readonly RuleForMatching[], domain: string): RuleDecision {
	const matched = matchRule(rules, domain);

	// No rule is not an error and not an approval. An unknown domain reaches a
	// human, which is spec §9.3's "everything else becomes pending".
	if (!matched) return { action: 'review', maxTier: PHASE_CEILING, ruleId: null };

	return {
		action: matched.action,
		// A rule may name `nda` — the column allows it and Phase 3 will honour it.
		// Clamping here is what stops an NDA-tier document reaching a requester
		// with no acceptance on file, in a phase that cannot record one.
		maxTier: matched.maxTier === 'nda' ? PHASE_CEILING : (matched.maxTier as DocumentTier),
		ruleId: matched.id
	};
}

export interface AdminRuleRow {
	id: string;
	pattern: string;
	action: AccessRuleAction;
	maxTier: DocumentTier;
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
	maxTier: z.enum(DOCUMENT_TIERS),
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

	return rows.map(toAdminRow);
}

export async function getRule(db: Db, id: string): Promise<AdminRuleRow | null> {
	const [row] = await db.select().from(accessRule).where(eq(accessRule.id, id)).limit(1);
	return row ? toAdminRow(row) : null;
}

function toAdminRow(row: typeof accessRule.$inferSelect): AdminRuleRow {
	return {
		...row,
		action: row.action as AccessRuleAction,
		maxTier: row.maxTier as DocumentTier
	};
}

export async function createRule(db: Db, input: RuleInput): Promise<string> {
	const [row] = await db.insert(accessRule).values(input).returning({ id: accessRule.id });
	if (!row) throw new Error('failed to create rule');
	return row.id;
}

export async function updateRule(db: Db, id: string, input: RuleInput): Promise<void> {
	await db.update(accessRule).set(input).where(eq(accessRule.id, id));
}

export async function deleteRule(db: Db, id: string): Promise<void> {
	await db.delete(accessRule).where(eq(accessRule.id, id));
}
