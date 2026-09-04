import { describe, expect, it } from 'vitest';
import { escapeMarkdown, formatEvent } from '../../src/lib/server/egress/format';
import type { EventModel } from '../../src/lib/server/egress/model';

const MODEL: EventModel = {
	action: 'access_request.pending',
	at: new Date('2026-09-03T10:12:00.000Z'),
	eventId: '8c1e0000-0000-4000-8000-000000000001',
	seq: '48213',
	deliveryId: '0f3c0000-0000-4000-8000-000000000002',
	subject: { type: 'access_request', id: 'req-1' },
	actor: { type: 'requester', id: 'person-1' },
	verified: true,
	data: { name: 'Dana Vogel', company: 'Acme GmbH', email: 'dana@acme.example' },
	summary: 'Access request from Acme GmbH needs review',
	link: 'https://trust.example.com/en/admin/requests/req-1'
};

describe('generic', () => {
	it('renders the model with snake_case keys', () => {
		const { body, contentType } = formatEvent('generic', MODEL);
		expect(contentType).toBe('application/json');

		expect(JSON.parse(body)).toEqual({
			event: 'access_request.pending',
			at: '2026-09-03T10:12:00.000Z',
			event_id: '8c1e0000-0000-4000-8000-000000000001',
			seq: '48213',
			delivery_id: '0f3c0000-0000-4000-8000-000000000002',
			verified: true,
			subject: { type: 'access_request', id: 'req-1' },
			actor: { type: 'requester', id: 'person-1' },
			summary: 'Access request from Acme GmbH needs review',
			link: 'https://trust.example.com/en/admin/requests/req-1',
			data: { name: 'Dana Vogel', company: 'Acme GmbH', email: 'dana@acme.example' }
		});
	});

	it('carries seq as a string so a consumer does not lose precision', () => {
		const body = JSON.parse(formatEvent('generic', { ...MODEL, seq: '9007199254740993' }).body);
		expect(body.seq).toBe('9007199254740993');
	});
});

describe('teams', () => {
	it('renders the Workflows envelope with an Adaptive Card', () => {
		const { body, contentType } = formatEvent('teams', MODEL);
		expect(contentType).toBe('application/json');

		const parsed = JSON.parse(body);
		expect(parsed.type).toBe('message');
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
		expect(parsed.attachments[0].contentUrl).toBeNull();
		expect(parsed.attachments[0].content.type).toBe('AdaptiveCard');
	});

	/**
	 * 1.4, not the newest available. Adaptive Card support differs by Teams
	 * surface and client, and a card that fails to render is indistinguishable
	 * to the operator from a delivery that never arrived — the worst possible
	 * failure for a notification channel (spec §3.3).
	 */
	it('declares card version 1.4', () => {
		const parsed = JSON.parse(formatEvent('teams', MODEL).body);
		expect(parsed.attachments[0].content.version).toBe('1.4');
	});

	// MessageCard is not the target and must not be written: Microsoft retired
	// Office 365 Connectors in Teams.
	it('is not a MessageCard', () => {
		expect(formatEvent('teams', MODEL).body).not.toContain('MessageCard');
	});

	it('carries an OpenUrl action to the link', () => {
		const card = JSON.parse(formatEvent('teams', MODEL).body).attachments[0].content;
		expect(card.actions).toEqual([
			{ type: 'Action.OpenUrl', title: 'Open in trust center', url: MODEL.link }
		]);
	});

	it('omits the actions array when there is no link', () => {
		const card = JSON.parse(formatEvent('teams', { ...MODEL, link: null }).body).attachments[0]
			.content;
		expect(card.actions).toBeUndefined();
	});

	// Nothing in a Teams channel should fetch from us.
	it('carries no images and no external references', () => {
		const body = formatEvent('teams', MODEL).body;
		expect(body).not.toContain('"Image"');
		expect(body).not.toContain('backgroundImage');
		expect(body).not.toContain('iconUrl');
	});

	/**
	 * Adaptive Card TextBlock renders markdown, and §4.3's data is in part
	 * supplied by whoever filled in a public form — so a company name of
	 * `[Password reset required](https://evil.example)` would otherwise become
	 * a clickable link in the security team's own channel, delivered by the
	 * trust center. Escaping is a property of the formatter, tested per
	 * formatter, and not of the enricher (spec §3.3).
	 */
	it('escapes markdown in every rendered string', () => {
		const hostile = '[Password reset required](https://evil.example)';
		const { body } = formatEvent('teams', {
			...MODEL,
			summary: hostile,
			data: { company: hostile, note: `**bold** _under_ \`code\``, [hostile]: 'x' }
		});

		expect(body).not.toContain('](https://evil.example)');
		const rendered = JSON.parse(body).attachments[0].content;
		expect(JSON.stringify(rendered)).toContain('\\\\[Password reset required\\\\]');

		// Titles come from `data` keys, not only values — a hostile fact *title*
		// must be escaped independently of the value-side guard above, or a
		// regression dropping title-escaping alone would reopen the injection
		// path while every other assertion here stays green.
		const factSet = rendered.body.find((block: { type: string }) => block.type === 'FactSet');
		expect(factSet.facts).toEqual(
			expect.arrayContaining([
				{ title: '\\[Password reset required\\]\\(https://evil.example\\)', value: 'x' }
			])
		);
	});

	it('renders a fact set from data', () => {
		const card = JSON.parse(formatEvent('teams', MODEL).body).attachments[0].content;
		const factSet = card.body.find((block: { type: string }) => block.type === 'FactSet');
		expect(factSet.facts).toEqual(
			expect.arrayContaining([{ title: 'company', value: 'Acme GmbH' }])
		);
	});

	it('renders a nested value without crashing', () => {
		const { body } = formatEvent('teams', { ...MODEL, data: { tiers: ['request', 'nda'] } });
		const card = JSON.parse(body).attachments[0].content;
		const factSet = card.body.find((block: { type: string }) => block.type === 'FactSet');
		expect(factSet.facts).toEqual([{ title: 'tiers', value: 'request, nda' }]);
	});
});

describe('escapeMarkdown', () => {
	it('escapes every character Adaptive Card treats as markup', () => {
		expect(escapeMarkdown('[a](b)')).toBe('\\[a\\]\\(b\\)');
		expect(escapeMarkdown('**a** _b_ `c`')).toBe('\\*\\*a\\*\\* \\_b\\_ \\`c\\`');
		expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
	});

	it('leaves ordinary text alone', () => {
		expect(escapeMarkdown('Acme GmbH')).toBe('Acme GmbH');
	});
});
