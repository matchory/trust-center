import { describe, expect, it } from 'vitest';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root } from 'mdast';
import { downgradeToSubset } from '../../src/lib/markdown/downgrade';
import { SUBSET_NODE_TYPES } from '../../src/lib/markdown/subset';

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

		const { root, dropped } = downgradeToSubset(tableNode as any);

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

		const { root, dropped } = downgradeToSubset(tableNode as any);

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

		const { root, dropped } = downgradeToSubset(tableNode as any);

		expect(dropped).toContain('image');
		expect(dropped).toContain('table');
		expect(JSON.stringify(root)).toContain('Text');
		expect(JSON.stringify(root)).not.toContain('https://x.test');
	});
});
