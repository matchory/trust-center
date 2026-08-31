import { describe, expect, it } from 'vitest';
import { isInSubset, MarkdownNotInSubset, parseAgreementBody } from '../../src/lib/markdown/subset';

describe('the restricted Markdown subset', () => {
	it('accepts headings, paragraphs, emphasis, lists and rules', () => {
		const root = parseAgreementBody(
			[
				'# Mutual NDA',
				'',
				'Text with **bold** and *italic*.',
				'',
				'- one',
				'- two',
				'',
				'---',
				'',
				'1. first'
			].join('\n')
		);

		expect(root.children.map((child) => child.type)).toEqual([
			'heading',
			'paragraph',
			'list',
			'thematicBreak',
			'list'
		]);
	});

	it('accepts emphasis nested inside strong', () => {
		expect(isInSubset('A **bold and *italic* run**.')).toBe(true);
	});

	// Each of these is a node type remark-parse produces and this subset refuses.
	it.each([
		['an image', '![alt](https://example.test/logo.png)'],
		['a link', 'See [the terms](https://example.test/terms).'],
		['raw HTML', '<script>alert(1)</script>'],
		['a fenced code block', '```\nrm -rf /\n```'],
		['inline code', 'Run `rm -rf /` now.'],
		['a block quote', '> quoted']
	])('refuses %s', (_label, markdown) => {
		expect(() => parseAgreementBody(markdown)).toThrow(MarkdownNotInSubset);
		expect(isInSubset(markdown)).toBe(false);
	});

	it('names the offending node type, so the form can say which', () => {
		try {
			parseAgreementBody('![alt](https://example.test/logo.png)');
			expect.unreachable('should have thrown');
		} catch (cause) {
			expect(cause).toBeInstanceOf(MarkdownNotInSubset);
			expect((cause as MarkdownNotInSubset).nodeType).toBe('image');
		}
	});

	it('treats a pipe table as ordinary paragraph text, not a table node', () => {
		// No remark-gfm, deliberately: the parser never produces a `table` node,
		// so this is prose rather than a rejected structure.
		const root = parseAgreementBody('| a | b |\n| - | - |');
		expect(root.children.every((child) => child.type === 'paragraph')).toBe(true);
	});
});
