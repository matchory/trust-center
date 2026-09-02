import { describe, expect, it } from 'vitest';
import { noticeCoverage } from '../../src/lib/server/content/subprocessors';

const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');

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

	it('does not warn when a post went live after the end date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: FEB, coveringPublishedAt: [MAR] })
		).toBeNull();
	});

	// The exact case P4.22 was written for: the addition was never announced,
	// and an unanchored condition would let the *removal* announcement clear it.
	it('still reports the unannounced addition when only the removal was announced', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: null, coveringPublishedAt: [JAN] })
		).toBe('addition-unannounced');
	});

	it('says nothing about an unpublished subprocessor', () => {
		expect(
			noticeCoverage({ published: false, startedAt: JAN, endedAt: MAR, coveringPublishedAt: [] })
		).toBeNull();
	});
});
