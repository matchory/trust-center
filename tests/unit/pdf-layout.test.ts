import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parseAgreementBody } from '../../src/lib/markdown/subset';
import { drawnText } from '../helpers/pdf';
import { embedFaces } from '../../src/lib/server/pdf/fonts';
import { layoutAgreement } from '../../src/lib/server/pdf/layout';

const FONT_DIR = './assets/fonts';

async function render(markdown: string): Promise<{ bytes: Uint8Array; pages: number }> {
	const pdf = await PDFDocument.create();
	const faces = await embedFaces(pdf, FONT_DIR);
	layoutAgreement(pdf, parseAgreementBody(markdown), faces, { title: 'Agreement' });
	const bytes = await pdf.save();
	return { bytes, pages: pdf.getPageCount() };
}

describe('the agreement layout engine', () => {
	it('draws a name no standard PDF font can encode', async () => {
		// pdf-lib's standard fonts are WinAnsi-only. `Łukasz` and `Şule` are not
		// representable, and on an NDA the mangled string would be the typed name
		// standing in for a signature.
		const { bytes } = await render('Signed by Łukasz Şule Čech.');
		expect(await drawnText(bytes)).toContain('Łukasz');
	});

	it('wraps a long paragraph rather than running off the page', async () => {
		const { bytes } = await render('word '.repeat(400).trim());
		const drawn = await drawnText(bytes);
		expect(drawn.split('\n').every((line) => line.length < 200)).toBe(true);
	});

	it('draws bold and italic runs mid-paragraph', async () => {
		const { bytes } = await render(
			'Plain **bold** and *italic* and **bold with *italic* inside**.'
		);
		const drawn = await drawnText(bytes);
		for (const fragment of ['Plain', 'bold', 'italic', 'inside']) {
			expect(drawn).toContain(fragment);
		}
	});

	it('indents nested lists and keeps every item', async () => {
		const { bytes } = await render(
			['1. first', '   - nested a', '   - nested b', '2. second'].join('\n')
		);
		const drawn = await drawnText(bytes);
		for (const fragment of ['first', 'nested a', 'nested b', 'second']) {
			expect(drawn).toContain(fragment);
		}
	});

	it('carries a nested list across a page boundary without losing an item', async () => {
		// §16: budget for this one. It is the defect this engine is most likely
		// to ship with, so it is a test before it is a bug.
		const items = Array.from({ length: 120 }, (_, index) => `   - item ${index}`);
		const { bytes, pages } = await render(['1. outer', ...items].join('\n'));

		expect(pages).toBeGreaterThan(1);
		const drawn = await drawnText(bytes);
		expect(drawn).toContain('item 0');
		expect(drawn).toContain('item 119');
	});

	it('does not orphan a heading at the foot of a page', async () => {
		const { bytes } = await render(
			[
				'x'.repeat(20),
				...Array(60).fill('Filler paragraph.'),
				'',
				'## Tail heading',
				'',
				'Body under it.'
			].join('\n\n')
		);
		expect(await drawnText(bytes)).toContain('Tail heading');
	});
});
