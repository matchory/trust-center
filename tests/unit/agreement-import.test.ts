import { describe, expect, it } from 'vitest';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Paragraph, Root } from 'mdast';
import { downgradeToSubset } from '../../src/lib/markdown/downgrade';
import { parseAgreementBody, SUBSET_NODE_TYPES } from '../../src/lib/markdown/subset';
import { IMPORT_TYPES, importAgreementBody } from '../../src/lib/server/nda/import';
import { docxToMarkdown } from '../../src/lib/server/nda/import/docx';
import { docxWith } from '../helpers/docx';
import { PdfHasNoText, pdfToMarkdown } from '../../src/lib/server/nda/import/pdf';
import { blankPdf, drawnText, textPdf } from '../helpers/pdf';
import { UploadRejected } from '../../src/lib/server/upload';

const parse = (markdown: string): Root => unified().use(remarkParse).parse(markdown) as Root;

describe('downgradeToSubset', () => {
	it('keeps a body that is already in the subset untouched', () => {
		const { root, dropped } = downgradeToSubset(parse('# Title\n\nA paragraph.'));

		expect(dropped).toEqual([]);
		expect(root.children.map((node) => node.type)).toEqual(['heading', 'paragraph']);
	});

	it('unwraps a link to its text and reports it', () => {
		const { root, dropped } = downgradeToSubset(parse('See [our policy](https://x.test).'));

		expect(dropped).toEqual(['link']);
		expect(JSON.stringify(root)).toContain('our policy');
		expect(JSON.stringify(root)).not.toContain('https://x.test');
	});

	it('drops an image entirely', () => {
		const { root, dropped } = downgradeToSubset(parse('![logo](https://x.test/l.png)'));

		expect(dropped).toEqual(['image']);
		expect(JSON.stringify(root)).not.toContain('x.test');
	});

	it('hoists a blockquote and reports it', () => {
		const { root, dropped } = downgradeToSubset(parse('> Quoted text.'));

		expect(dropped).toEqual(['blockquote']);
		expect(root.children.map((node) => node.type)).toEqual(['paragraph']);
	});

	it('turns code into a paragraph carrying its literal text', () => {
		const { root, dropped } = downgradeToSubset(parse('```\nliteral\n```'));

		expect(dropped).toEqual(['code']);
		expect(JSON.stringify(root)).toContain('literal');
	});

	it('reports each changed type once, sorted', () => {
		const { dropped } = downgradeToSubset(
			parse('![a](https://x.test/a.png)\n\n![b](https://x.test/b.png)\n\n> q')
		);

		expect(dropped).toEqual(['blockquote', 'image']);
	});

	it('leaves no node type outside the subset anywhere in the tree', () => {
		const { root } = downgradeToSubset(
			parse('# T\n\n> [link](https://x.test) and `code`\n\n![i](https://x.test/i.png)')
		);

		const types: string[] = [];
		const walk = (node: { type: string; children?: unknown[] }): void => {
			types.push(node.type);
			for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
				walk(child);
			}
		};
		walk(root);

		expect(types.filter((type) => !SUBSET_NODE_TYPES.includes(type as never))).toEqual([]);
	});

	it('converts a simple table to paragraphs', () => {
		const tableNode = {
			type: 'root',
			children: [
				{
					type: 'table',
					children: [
						{
							type: 'tableRow',
							children: [
								{
									type: 'tableCell',
									children: [{ type: 'text', value: 'Cell 1' }]
								},
								{
									type: 'tableCell',
									children: [{ type: 'text', value: 'Cell 2' }]
								}
							]
						}
					]
				}
			]
		};

		const { root, dropped } = downgradeToSubset(tableNode as unknown as Root);

		expect(dropped).toEqual(['table', 'tableCell', 'tableRow']);
		expect(root.children.map((node) => node.type)).toEqual(['paragraph']);
		expect(JSON.stringify(root)).toContain('Cell 1 — Cell 2');
	});

	it('tracks all unsupported nodes inside table cells', () => {
		const tableNode = {
			type: 'root',
			children: [
				{
					type: 'table',
					children: [
						{
							type: 'tableRow',
							children: [
								{
									type: 'tableCell',
									children: [
										{
											type: 'paragraph',
											children: [
												{ type: 'text', value: 'See ' },
												{
													type: 'link',
													url: 'https://x.test',
													children: [{ type: 'text', value: 'link' }]
												},
												{ type: 'text', value: ' and ' },
												{
													type: 'image',
													url: 'https://x.test/i.png',
													alt: 'logo'
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		};

		const { root, dropped } = downgradeToSubset(tableNode as unknown as Root);

		expect(dropped).toContain('image');
		expect(dropped).toContain('link');
		expect(dropped).toContain('table');
		expect(JSON.stringify(root)).toContain('See link and');
		expect(JSON.stringify(root)).not.toContain('https://x.test/i.png');
	});

	it('drops empty cells from table rows', () => {
		const tableNode = {
			type: 'root',
			children: [
				{
					type: 'table',
					children: [
						{
							type: 'tableRow',
							children: [
								{
									type: 'tableCell',
									children: [{ type: 'image', url: 'https://x.test/1.png', alt: 'only-image' }]
								},
								{
									type: 'tableCell',
									children: [{ type: 'text', value: 'Text' }]
								},
								{
									type: 'tableCell',
									children: [{ type: 'image', url: 'https://x.test/2.png', alt: 'only-image' }]
								}
							]
						}
					]
				}
			]
		};

		const { root, dropped } = downgradeToSubset(tableNode as unknown as Root);

		expect(dropped).toContain('image');
		expect(dropped).toContain('table');
		expect(JSON.stringify(root)).toContain('Text');
		expect(JSON.stringify(root)).not.toContain('https://x.test');
	});

	it('preserves phrasing structure when downgrading inline code', () => {
		// Inline code has to become a `text`, not the `paragraph` block code
		// becomes: a block inside phrasing content is invalid mdast, and the
		// renderer reads it as an empty paragraph rather than failing loudly.
		const { root } = downgradeToSubset(parse('See `literal` here.'));

		expect(root.children).toHaveLength(1);
		expect(root.children[0]!.type).toBe('paragraph');

		const para = root.children[0] as Paragraph;
		const blockNodeTypes = ['paragraph', 'heading', 'blockquote', 'list', 'thematicBreak'];
		for (const child of para.children) {
			expect(blockNodeTypes).not.toContain(child.type);
		}

		// Verify the text content is preserved
		expect(JSON.stringify(root)).toContain('See');
		expect(JSON.stringify(root)).toContain('literal');
		expect(JSON.stringify(root)).toContain('here');
	});
});

/**
 * The import fixtures are built in code rather than committed as binaries, so
 * they are themselves capable of being wrong. These two cases exist so that a
 * malformed fixture fails here, by name, instead of surfacing three tasks later
 * as a confusing `mammoth` error or an extractor that finds no text.
 */
describe('import fixtures', () => {
	it('builds a docx mammoth can read', async () => {
		const mammoth = await import('mammoth');

		const result = await mammoth.convertToHtml({
			buffer: Buffer.from(docxWith([{ text: 'Hallo' }]))
		});

		expect(result.value).toContain('Hallo');
	});

	it('builds a pdf that carries text, and a blank one that does not', async () => {
		expect(await drawnText(await textPdf([{ text: 'Vertraulich', size: 20 }]))).toContain(
			'Vertraulich'
		);
		expect(await drawnText(await blankPdf())).toBe('');
	});
});

describe('pdfToMarkdown', () => {
	it('promotes a larger line to a heading and keeps body text as paragraphs', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: 'Die Parteien vereinbaren Folgendes.', size: 11 }
			])
		);

		expect(markdown).toContain('# Vertraulichkeitsvereinbarung');
		expect(markdown).toContain('Die Parteien vereinbaren Folgendes.');
	});

	it('keeps an enumerated clause as text, not as a list', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: '1. Definitionen im Sinne dieser Vereinbarung.', size: 11 },
				{ text: '2. Geheimhaltung der offengelegten Informationen.', size: 11 }
			])
		);

		// The escape is what makes this true, and it is why the serializer does
		// the enforcing (P3.21): our renderer numbers list items itself, so a
		// clause imported as a list item can render under a different number
		// than the contract it came from.
		expect(markdown).toContain('1\\. Definitionen');

		const root = parseAgreementBody(markdown);
		expect(root.children.some((node) => node.type === 'list')).toBe(false);
	});

	it('produces a body the subset validator accepts', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Titel', size: 20 },
				{ text: 'Ein Absatz mit Text.', size: 11 }
			])
		);

		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});

	it('refuses a PDF with no extractable text', async () => {
		await expect(pdfToMarkdown(await blankPdf())).rejects.toBeInstanceOf(PdfHasNoText);
	});
});

describe('docxToMarkdown', () => {
	it('carries a heading and a paragraph into the subset', async () => {
		const { markdown, dropped } = await docxToMarkdown(
			docxWith([
				{ text: 'Vertraulichkeitsvereinbarung', heading: true },
				{ text: 'Die Parteien vereinbaren Folgendes.' }
			])
		);

		expect(markdown).toContain('Vertraulichkeitsvereinbarung');
		expect(markdown).toContain('Die Parteien vereinbaren Folgendes.');
		expect(dropped).toEqual([]);
		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});

	it('keeps an enumerated clause as text', async () => {
		const { markdown } = await docxToMarkdown(
			docxWith([{ text: '1. Definitionen im Sinne dieser Vereinbarung.' }])
		);

		const root = parseAgreementBody(markdown);
		expect(root.children.some((node) => node.type === 'list')).toBe(false);
	});

	it('produces a body the subset validator accepts, whatever came in', async () => {
		const { markdown } = await docxToMarkdown(
			docxWith([{ text: 'Ein Absatz.' }, { text: 'Noch einer.' }])
		);

		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});
});

describe('importAgreementBody', () => {
	it('reads a pdf', async () => {
		const bytes = await textPdf([{ text: 'Ein Absatz.', size: 11 }]);

		const imported = await importAgreementBody({
			filename: 'a.pdf',
			contentType: 'application/pdf',
			bytes
		});

		expect(imported.markdown).toContain('Ein Absatz.');
		expect(imported.dropped).toEqual([]);
	});

	it('reads a docx', async () => {
		const imported = await importAgreementBody({
			filename: 'a.docx',
			contentType: IMPORT_TYPES[1]!,
			bytes: docxWith([{ text: 'Ein Absatz.' }])
		});

		expect(imported.markdown).toContain('Ein Absatz.');
	});

	it('refuses a type it cannot read', async () => {
		await expect(
			importAgreementBody({ filename: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array() })
		).rejects.toBeInstanceOf(UploadRejected);
	});
});
