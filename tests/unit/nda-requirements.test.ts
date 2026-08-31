import { describe, expect, it } from 'vitest';
import { DefaultTemplateMissing, proposeFrom } from '../../src/lib/server/nda/requirements';

const DEFAULT = 'default-template';
const ACME = 'acme-template';
const BOSCH = 'bosch-template';

describe('the requirement proposal', () => {
	it('proposes nothing for request-tier documents in no NDA-carrying group', () => {
		expect(
			proposeFrom([{ id: 'd1', tier: 'request', groupTemplateIds: [null] }], {
				defaultTemplateId: DEFAULT
			})
		).toEqual([]);
	});

	it('takes the union across several groups', () => {
		// Customer A and Customer B each sign their own agreement and both need
		// the security pack, so the pack sits in both groups. The union is what
		// the *scope* requires, and the approver then narrows it — resolving from
		// the document graph alone is what would force one document copy per
		// customer.
		expect(
			proposeFrom(
				[
					{ id: 'd1', tier: 'request', groupTemplateIds: [ACME] },
					{ id: 'd2', tier: 'request', groupTemplateIds: [BOSCH] }
				],
				{ defaultTemplateId: DEFAULT }
			).sort()
		).toEqual([ACME, BOSCH].sort());
	});

	it('adds the default template for an nda-tier document rather than replacing the group one', () => {
		// An `else` chain here would let filing an nda-tier document into any
		// NDA-carrying group silently remove the general agreement from it — a
		// gate weakening produced by a filing action.
		expect(
			proposeFrom([{ id: 'd1', tier: 'nda', groupTemplateIds: [ACME] }], {
				defaultTemplateId: DEFAULT
			}).sort()
		).toEqual([ACME, DEFAULT].sort());
	});

	it('proposes each template once however many documents carry it', () => {
		expect(
			proposeFrom(
				[
					{ id: 'd1', tier: 'nda', groupTemplateIds: [ACME] },
					{ id: 'd2', tier: 'nda', groupTemplateIds: [ACME] }
				],
				{ defaultTemplateId: DEFAULT }
			).sort()
		).toEqual([ACME, DEFAULT].sort());
	});

	it('fails closed for an nda-tier document with no default template configured', () => {
		// Resolution fails rather than silently granting an ungated document.
		expect(() =>
			proposeFrom([{ id: 'd1', tier: 'nda', groupTemplateIds: [] }], { defaultTemplateId: null })
		).toThrow(DefaultTemplateMissing);
	});

	it('does not fail closed when no nda-tier document is in scope', () => {
		expect(
			proposeFrom([{ id: 'd1', tier: 'request', groupTemplateIds: [ACME] }], {
				defaultTemplateId: null
			})
		).toEqual([ACME]);
	});
});
