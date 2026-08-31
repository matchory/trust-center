import type { Root, RootContent } from 'mdast';
import { SUBSET_NODE_TYPES } from './subset';

const ALLOWED = new Set<string>(SUBSET_NODE_TYPES);

/**
 * §5.1's subset is what an agreement body may contain, and `parseAgreementBody`
 * refuses everything else. That refusal is right for a body somebody typed and
 * wrong for one converted out of a contract: a real DOCX carries links, images
 * and tables, and rejecting the document because of one table would make import
 * useless on exactly its intended input (P3.23).
 *
 * So conversion ends here, mapping each unsupported node onto the nearest thing
 * the subset can express, and naming what it changed so the author is told at
 * the moment they can still fix it. After this pass a `MarkdownNotInSubset` is
 * a bug in this file, not an expected rejection.
 */
export interface Downgraded {
	root: Root;
	/** Node types removed or rewritten, de-duplicated and sorted. */
	dropped: string[];
}

export function downgradeToSubset(root: Root): Downgraded {
	const dropped = new Set<string>();
	const children = rewriteAll(root.children, dropped);

	return {
		root: { type: 'root', children },
		dropped: [...dropped].sort()
	};
}

function rewriteAll(nodes: RootContent[], dropped: Set<string>): RootContent[] {
	return nodes.flatMap((node) => rewrite(node, dropped));
}

/**
 * Returns zero or more replacement nodes. Zero is a deletion; more than one is
 * a hoist — a blockquote's children take its place rather than its content
 * being lost with it.
 */
function rewrite(node: RootContent, dropped: Set<string>): RootContent[] {
	if (ALLOWED.has(node.type)) {
		if ('children' in node && Array.isArray(node.children)) {
			return [{ ...node, children: rewriteAll(node.children as any[], dropped) }] as RootContent[];
		}
		return [node];
	}

	dropped.add(node.type);

	switch (node.type) {
		// The text survives, the destination does not: a URL in a signed
		// agreement is a term nobody agreed to, and the subset cannot render it.
		case 'link':
		case 'linkReference':
			return rewriteAll(node.children as RootContent[], dropped);

		// A quote is a paragraph with an indent we cannot express; its contents
		// are the part that matters.
		case 'blockquote':
			return rewriteAll(node.children as RootContent[], dropped);

		// Literal text, kept as text. `value` rather than children: these are
		// leaves.
		case 'code':
		case 'inlineCode':
			return [{ type: 'paragraph', children: [{ type: 'text', value: node.value }] }];

		// One paragraph per row, cells joined — a table's information is the row,
		// and a row read aloud is a sentence.
		case 'table':
			return ((node.children ?? []) as unknown[]).flatMap((row) => rewriteRow(row, dropped));

		// Images, raw HTML, footnotes and anything else a parser can produce
		// carry nothing the subset can show.
		default:
			return [];
	}
}

function rewriteRow(row: unknown, dropped: Set<string>): RootContent[] {
	const r = row as any;
	if (!('children' in r) || !Array.isArray(r.children)) return [];

	const cells = (r.children as unknown[])
		.map((cell: unknown) => textOf(cell, dropped).trim())
		.filter((text) => text.length > 0);

	if (cells.length === 0) return [];
	return [{ type: 'paragraph', children: [{ type: 'text', value: cells.join(' — ') }] }];
}

function textOf(node: unknown, dropped: Set<string>): string {
	const n = node as any;
	if ('value' in n && typeof n.value === 'string') return n.value;
	if (!('children' in n) || !Array.isArray(n.children)) return '';
	return (n.children as unknown[]).map((child: unknown) => textOf(child, dropped)).join('');
}
