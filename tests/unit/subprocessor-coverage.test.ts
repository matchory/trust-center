import { describe, expect, it } from 'vitest';
import { noticeCoverage } from '../../src/lib/server/content/subprocessors';

const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');
const APR = new Date('2026-04-01T00:00:00Z');

describe('noticeCoverage', () => {
	it('warns when a published addition has no covering post', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: null, coveringPublishedAt: [] })
		).toBe('addition-unannounced');
	});

	// The negative matters as much as the positive: a badge that also fires on
	// announced changes is noise, and noise is what P4.10 is about.
	it('does not warn when a covering post went live after the start date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: null, coveringPublishedAt: [FEB] })
		).toBeNull();
	});

	// P4.22: the anchor. Unanchored, any linked post would clear this.
	it('warns when the only covering post predates the start date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: null, coveringPublishedAt: [JAN] })
		).toBe('addition-unannounced');
	});

	it('falls back to "any covering post" when there is no start date', () => {
		expect(
			noticeCoverage({
				published: true,
				startedAt: null,
				endedAt: null,
				coveringPublishedAt: [JAN]
			})
		).toBeNull();
		expect(
			noticeCoverage({ published: true, startedAt: null, endedAt: null, coveringPublishedAt: [] })
		).toBe('addition-unannounced');
	});

	it('warns when an ended subprocessor has no post after its end date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: MAR, coveringPublishedAt: [FEB] })
		).toBe('removal-unannounced');
	});

	// A single post can no longer clear both conditions once there is an end
	// date: the addition's window is upper-bounded by `endedAt` (P4.22), so a
	// post at or after the end covers only the removal. Covering both here
	// needs two separate posts, one inside each window.
	it('does not warn when the addition and the removal each have their own covering post', () => {
		expect(
			noticeCoverage({
				published: true,
				startedAt: JAN,
				endedAt: FEB,
				coveringPublishedAt: [JAN, MAR]
			})
		).toBeNull();
	});

	// The case the condition exists for: added silently, and the only covering
	// post is the one announcing the REMOVAL. Without the upper bound this
	// clears the addition warning on the strength of a post announcing the
	// opposite fact (P4.22).
	it('reports the unannounced addition when only the removal was announced', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: MAR, coveringPublishedAt: [APR] })
		).toBe('addition-unannounced');
	});

	// Rule 2: the removal is checked first because it is the live obligation and
	// only one badge is shown. This is the only shape where the order is
	// observable — both conditions true at once — so without it, swapping the
	// two `if` branches passes the whole suite.
	it('reports the removal when the addition is also unannounced', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: MAR, coveringPublishedAt: [] })
		).toBe('removal-unannounced');
	});

	it('says nothing about an unpublished subprocessor', () => {
		expect(
			noticeCoverage({ published: false, startedAt: JAN, endedAt: MAR, coveringPublishedAt: [] })
		).toBeNull();
	});
});
