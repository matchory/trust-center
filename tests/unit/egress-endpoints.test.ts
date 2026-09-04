import { describe, expect, it } from 'vitest';
import {
	highFrequencyPatterns,
	HIGH_FREQUENCY_WEEKLY_EVENTS
} from '../../src/lib/server/egress/endpoints';

/**
 * Spec §9.1's whole mechanism: `document.downloaded` is deliberately not
 * throttled, so the operator chooses what their channel contains and is told
 * what they are choosing. Until this file existed the warning was computed
 * inside a page `load` and asserted by nothing.
 */
describe('highFrequencyPatterns', () => {
	it('warns only above the threshold, and reports the count it warned on', () => {
		const rates = { 'document.downloaded': HIGH_FREQUENCY_WEEKLY_EVENTS + 1 };

		expect(highFrequencyPatterns(['document.downloaded'], rates)).toEqual([
			{ pattern: 'document.downloaded', weekly: HIGH_FREQUENCY_WEEKLY_EVENTS + 1 }
		]);
	});

	/** Strictly above, so an endpoint sitting exactly on the line is not nagged. */
	it('does not warn at exactly the threshold', () => {
		const rates = { 'document.downloaded': HIGH_FREQUENCY_WEEKLY_EVENTS };

		expect(highFrequencyPatterns(['document.downloaded'], rates)).toEqual([]);
	});

	/**
	 * The property the summing exists for: an operator selecting `document.*`
	 * is choosing the total of what it expands to. Neither action alone crosses
	 * the threshold, so a per-action check would stay silent about a pattern
	 * carrying nearly twice it.
	 */
	it('sums every action a wildcard matches rather than taking the largest', () => {
		const half = Math.ceil(HIGH_FREQUENCY_WEEKLY_EVENTS * 0.6);
		const rates = { 'document.downloaded': half, 'document.viewed': half };

		expect(highFrequencyPatterns(['document.*'], rates)).toEqual([
			{ pattern: 'document.*', weekly: half * 2 }
		]);
	});

	it('ignores actions the pattern does not match, and quiet patterns entirely', () => {
		const rates = { 'access_request.pending': HIGH_FREQUENCY_WEEKLY_EVENTS * 10 };

		expect(highFrequencyPatterns(['document.*', 'access_grant.revoked'], rates)).toEqual([]);
	});
});
