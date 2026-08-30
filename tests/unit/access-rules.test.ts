import { describe, expect, it } from 'vitest';
import {
	decideFromRules,
	matchRule,
	patternMatches,
	RULE_PATTERN
} from '../../src/lib/server/access/rules';
import type { RuleForMatching } from '../../src/lib/server/access/rules';

function rule(partial: Partial<RuleForMatching> & { pattern: string }): RuleForMatching {
	return {
		id: partial.pattern,
		pattern: partial.pattern,
		action: partial.action ?? 'review',
		tiers: partial.tiers ?? ['request'],
		priority: partial.priority ?? 100
	};
}

describe('patternMatches', () => {
	it('matches an exact domain', () => {
		expect(patternMatches('acme.example', 'acme.example')).toBe(true);
		expect(patternMatches('acme.example', 'notacme.example')).toBe(false);
	});

	it('matches a leading wildcard against subdomains only', () => {
		expect(patternMatches('*.acme.example', 'eu.acme.example')).toBe(true);
		expect(patternMatches('*.acme.example', 'a.b.acme.example')).toBe(true);
		// The bare domain is NOT a subdomain of itself. An operator wanting both
		// writes both rules, which is visible; inferring it is not.
		expect(patternMatches('*.acme.example', 'acme.example')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(patternMatches('ACME.example', 'acme.EXAMPLE')).toBe(true);
	});

	it('does not treat the wildcard as a substring match', () => {
		// The failure that would quietly hand documents to a lookalike domain.
		expect(patternMatches('*.acme.example', 'evilacme.example')).toBe(false);
	});

	it('refuses empty input on either side', () => {
		expect(patternMatches('', 'acme.example')).toBe(false);
		expect(patternMatches('acme.example', '')).toBe(false);
	});
});

describe('matchRule', () => {
	it('returns null when nothing matches', () => {
		expect(matchRule([rule({ pattern: 'acme.example' })], 'other.example')).toBeNull();
	});

	it('prefers the lower priority number', () => {
		const matched = matchRule(
			[
				rule({ pattern: 'acme.example', priority: 50, action: 'deny' }),
				rule({ pattern: 'acme.example', priority: 10, action: 'auto_approve' })
			],
			'acme.example'
		);

		expect(matched?.action).toBe('auto_approve');
	});

	it('breaks a priority tie in favour of the more specific pattern', () => {
		// Otherwise the outcome depends on row order, which is not a decision
		// anybody made and would change under an unrelated reindex.
		const matched = matchRule(
			[
				rule({ pattern: '*.acme.example', priority: 100, action: 'review' }),
				rule({ pattern: 'eu.acme.example', priority: 100, action: 'auto_approve' })
			],
			'eu.acme.example'
		);

		expect(matched?.action).toBe('auto_approve');
	});

	it('is order-independent', () => {
		const rules = [
			rule({ pattern: '*.acme.example', priority: 100, action: 'review' }),
			rule({ pattern: 'eu.acme.example', priority: 100, action: 'auto_approve' })
		];

		expect(matchRule(rules, 'eu.acme.example')?.action).toBe(
			matchRule([...rules].reverse(), 'eu.acme.example')?.action
		);
	});

	it('prefers the longer wildcard when both are wildcards at equal priority', () => {
		const matched = matchRule(
			[
				rule({ pattern: '*.example', priority: 100, action: 'deny' }),
				rule({ pattern: '*.acme.example', priority: 100, action: 'auto_approve' })
			],
			'eu.acme.example'
		);

		expect(matched?.action).toBe('auto_approve');
	});
});

describe('decideFromRules', () => {
	it('defaults to review when no rule matches', () => {
		// The safe default: an unknown domain reaches a human, never a document.
		// Phase 2 returned a `request` ceiling here; a set makes "review,
		// granting nothing by pattern" expressible, which is what an unknown
		// domain deserves.
		const decision = decideFromRules([], 'stranger.example');

		expect(decision.action).toBe('review');
		expect(decision.tiers).toEqual([]);
		expect(decision.ruleId).toBeNull();
	});

	it('carries the matched rule id so the decision is reconstructible', () => {
		const decision = decideFromRules(
			[rule({ pattern: 'acme.example', action: 'auto_approve', tiers: ['request'] })],
			'acme.example'
		);

		expect(decision).toEqual({
			action: 'auto_approve',
			tiers: ['request'],
			ruleId: 'acme.example'
		});
	});

	it('drops a tier this phase does not honour', () => {
		// A rule may name `nda`, because the table admits it and the backfill
		// preserved it. Dropping it here is what stops an NDA-tier document
		// reaching a requester with no acceptance on file.
		const decision = decideFromRules(
			[rule({ pattern: 'acme.example', action: 'auto_approve', tiers: ['request', 'nda'] })],
			'acme.example'
		);

		expect(decision.tiers).toEqual(['request']);
	});

	it('drops the whole blanket when a rule names only nda', () => {
		const decision = decideFromRules(
			[rule({ pattern: 'acme.example', action: 'auto_approve', tiers: ['nda'] })],
			'acme.example'
		);

		expect(decision.tiers).toEqual([]);
	});
});

describe('RULE_PATTERN', () => {
	it('accepts the two forms the matcher understands', () => {
		expect(RULE_PATTERN.test('acme.example')).toBe(true);
		expect(RULE_PATTERN.test('*.acme.example')).toBe(true);
		expect(RULE_PATTERN.test('eu.acme.co.uk')).toBe(true);
	});

	it('rejects patterns that could never match anything', () => {
		// Rejected at entry rather than discovered at decision time.
		for (const pattern of ['*', '*.example', 'acme', '*acme.example', '', '.acme.example']) {
			expect(RULE_PATTERN.test(pattern), pattern).toBe(false);
		}
	});
});
