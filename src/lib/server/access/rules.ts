import type { AccessRuleAction } from '../../access-types';
import type { DocumentTier } from '../../content-types';

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
