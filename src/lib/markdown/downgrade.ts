import type { Root, RootContent } from 'mdast';
import { SUBSET_NODE_TYPES } from './subset';

const ALLOWED = new Set<string>(SUBSET_NODE_TYPES);

/**
 * Generic node type that encompasses all mdast nodes we process. All nodes
 * have a `type` field; some have `value` (leaves), others have `children`.
 */
interface Node {
	type: string;
	value?: string;
	children?: Node[];
	[key: string]: unknown;
}

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
	const children = rewriteAll(root.children as Node[], dropped) as RootContent[];

	return {
		root: { type: 'root', children },
		dropped: [...dropped].sort()
	};
}

function rewriteAll(nodes: Node[], dropped: Set<string>): Node[] {
	return nodes.flatMap((node) => rewrite(node, dropped));
}

/**
 * Returns zero or more replacement nodes. Zero is a deletion; more than one is
 * a hoist — a blockquote's children take its place rather than its content
 * being lost with it.
 */
function rewrite(node: Node, dropped: Set<string>): Node[] {
	if (ALLOWED.has(node.type)) {
		if (Array.isArray(node.children)) {
			return [{ ...node, children: rewriteAll(node.children, dropped) }];
		}
		return [node];
	}

	dropped.add(node.type);

	switch (node.type) {
		// The text survives, the destination does not: a URL in a signed
		// agreement is a term nobody agreed to, and the subset cannot render it.
		case 'link':
		case 'linkReference':
			return rewriteAll(node.children ?? [], dropped);

		// A quote is a paragraph with an indent we cannot express; its contents
		// are the part that matters.
		case 'blockquote':
			return rewriteAll(node.children ?? [], dropped);

		// Block code becomes a paragraph with literal text.
		case 'code':
			return [{ type: 'paragraph', children: [{ type: 'text', value: node.value ?? '' }] }];

		// Inline code becomes a text node carrying its literal value. It must not
		// become a paragraph, which would create invalid mdast (a block inside
		// phrasing content).
		case 'inlineCode':
			return [{ type: 'text', value: node.value ?? '' }];

		// One paragraph per row, cells joined — a table's information is the row,
		// and a row read aloud is a sentence. Table cells contain flow content,
		// so run them through rewrite() to track all unsupported nodes in `dropped`.
		case 'table':
			return (node.children ?? []).flatMap((row) => rewriteRow(row, dropped));

		// Inline nodes with children (like delete/strikethrough) carry contract
		// text in their decoration. Unwrap them rather than discarding their
		// content. Only genuine leaves (images, footnotes, HTML) are dropped.
		default:
			if (Array.isArray(node.children)) {
				return rewriteAll(node.children, dropped);
			}
			return [];
	}
}

function rewriteRow(row: Node, dropped: Set<string>): Node[] {
	dropped.add('tableRow');
	if (!Array.isArray(row.children)) return [];

	const cells = row.children
		.flatMap((cell) => rewriteCell(cell, dropped))
		.map((node) => textOfNode(node))
		.filter((text) => text.length > 0);

	if (cells.length === 0) return [];
	return [{ type: 'paragraph', children: [{ type: 'text', value: cells.join(' — ') }] }];
}

/**
 * Rewrite a table cell's content. Run it through rewrite() so that any
 * unsupported node types (like images, links) inside the cell are both
 * mapped and recorded in `dropped`.
 */
function rewriteCell(cell: Node, dropped: Set<string>): Node[] {
	dropped.add('tableCell');
	if (!Array.isArray(cell.children)) return [];

	const rewritten = cell.children.flatMap((child) => rewrite(child, dropped));
	// Flatten nested paragraph structures from things like inlineCode
	// inside cell content, and preserve text nodes.
	return rewritten;
}

function textOfNode(node: Node): string {
	if (typeof node.value === 'string') return node.value;
	if (!Array.isArray(node.children)) return '';
	return node.children.map((child) => textOfNode(child)).join('');
}
