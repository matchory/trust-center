import { describe, expect, it } from 'vitest';
import { MAIL_TEMPLATES, renderTemplate } from '../../src/lib/server/mail/templates';

const SAMPLE = {
	url: 'https://t.example/a',
	documentCount: 2,
	agreementCount: 1,
	expiresAt: '2026-12-01',
	reason: 'a reason'
};

describe('renderTemplate', () => {
	it('renders the verification mail in the requested locale', () => {
		const de = renderTemplate('verify_request', 'de', SAMPLE);
		const en = renderTemplate('verify_request', 'en', SAMPLE);

		expect(de.subject).not.toBe(en.subject);
		expect(de.text).toContain(SAMPLE.url);
		expect(en.text).toContain(SAMPLE.url);
	});

	it('renders every declared template in every served locale', () => {
		// A template added without its German string is a defect that ships
		// silently otherwise — the fallback is an English mail to a German
		// prospect, which is exactly what spec §7 exists to prevent.
		for (const id of MAIL_TEMPLATES) {
			for (const locale of ['de', 'en'] as const) {
				const rendered = renderTemplate(id, locale, SAMPLE);

				expect(rendered.subject.length, `${id}/${locale} subject`).toBeGreaterThan(0);
				expect(rendered.text.length, `${id}/${locale} body`).toBeGreaterThan(0);
			}
		}
	});

	it('substitutes every placeholder it is given', () => {
		// A leftover {placeholder} in a sent mail is visible to the recipient.
		for (const id of MAIL_TEMPLATES) {
			for (const locale of ['de', 'en'] as const) {
				const rendered = renderTemplate(id, locale, SAMPLE);

				expect(rendered.text, `${id}/${locale}`).not.toMatch(/\{[a-zA-Z]+\}/);
				expect(rendered.subject, `${id}/${locale}`).not.toMatch(/\{[a-zA-Z]+\}/);
			}
		}
	});

	it('tells an approved requester with an outstanding agreement where to go next', () => {
		// `request_approved` says access is ready. Under this phase an approval
		// sometimes means one step remains, and the two land the reader in
		// different places — so they are two templates, not one with a clause.
		const rendered = renderTemplate('request_acceptance_required', 'en', {
			url: 'https://trust.example/en/access',
			documentCount: 3,
			agreementCount: 1
		});

		expect(rendered.subject).not.toBe(renderTemplate('request_approved', 'en', SAMPLE).subject);
		expect(rendered.text).toContain('https://trust.example/en/access');
	});

	it('renders the two locales differently for every template', () => {
		for (const id of MAIL_TEMPLATES) {
			const de = renderTemplate(id, 'de', SAMPLE);
			const en = renderTemplate(id, 'en', SAMPLE);

			expect(de.text, `${id} is not actually translated`).not.toBe(en.text);
		}
	});
});
