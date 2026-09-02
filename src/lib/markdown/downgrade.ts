import type {
	Root,
	RootContent,
	PhrasingContent,
	Table,
	TableRow,
	TableCell,
	ListItem
} from 'mdast';
import { SUBSET_NODE_TYPES } from './subset';

const ALLOWED = new Set<string>(SUBSET_NODE_TYPES);

/**
 * The node types a table cell can hold that belong at block level. mdast types a
 * cell's children as phrasing, but the DOCX path builds cells out of converted
 * HTML and a `<td>` there can hold a whole paragraph, so a cell's children are
 * routed by what they actually are rather than by what the type says.
 */
const BLOCK_IN_CELL = new Set<string>([
	'paragraph',
	'heading',
	'blockquote',
	'list',
	'thematicBreak',
	'code',
	'table'
]);

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
	const children = rewriteBlock(root.children, dropped);

	return {
		root: { type: 'root', children },
		dropped: [...dropped].sort()
	};
}

/**
 * Block and phrasing content are rewritten by two functions rather than one, so
 * that a replacement can never land at the wrong level: an `inlineCode` inside a
 * paragraph has to become a `text`, and a fenced `code` between paragraphs has
 * to become a `paragraph`. A single generic pass could not tell those apart and
 * produced a block node inside phrasing content, which is invalid mdast.
 *
 * Returns zero or more replacement nodes. Zero is a deletion; more than one is a
 * hoist — a blockquote's children take its place rather than its content being
 * lost with it.
 */
function rewriteBlock(nodes: RootContent[], dropped: Set<string>): RootContent[] {
	return nodes.flatMap((node): RootContent[] => {
		if (ALLOWED.has(node.type)) {
			switch (node.type) {
				case 'heading':
					return [{ ...node, children: rewritePhrasing(node.children, dropped) }];

				case 'paragraph':
					return [{ ...node, children: rewritePhrasing(node.children, dropped) }];

				case 'list':
					return [
						{ ...node, children: node.children.map((item) => rewriteListItem(item, dropped)) }
					];

				// `thematicBreak`, `text` and `break` are leaves; nothing else in
				// the subset reaches block level.
				default:
					return [node];
			}
		}

		dropped.add(node.type);

		switch (node.type) {
			// A quote is a paragraph with an indent we cannot express; its
			// contents are the part that matters.
			case 'blockquote':
				return rewriteBlock(node.children, dropped);

			// Block code becomes a paragraph with literal text.
			case 'code':
				return [{ type: 'paragraph', children: [{ type: 'text', value: node.value }] }];

			case 'table':
				return rewriteTable(node, dropped);

			// Images, raw HTML, footnote definitions and anything else a parser
			// can produce are dropped whole. An earlier version unwrapped any
			// container with children here, which is how phrasing nodes ended up
			// at block level; `dropped` still names the type, so the author is
			// told what went.
			default:
				return [];
		}
	});
}

function rewritePhrasing(nodes: PhrasingContent[], dropped: Set<string>): PhrasingContent[] {
	return nodes.flatMap((node): PhrasingContent[] => {
		if (ALLOWED.has(node.type)) {
			switch (node.type) {
				case 'strong':
					return [{ ...node, children: rewritePhrasing(node.children, dropped) }];

				case 'emphasis':
					return [{ ...node, children: rewritePhrasing(node.children, dropped) }];

				// `text` and `break` are leaves.
				default:
					return [node];
			}
		}

		dropped.add(node.type);

		switch (node.type) {
			// The text survives, the destination does not: a URL in a signed
			// agreement is a term nobody agreed to, and the subset cannot render it.
			case 'link':
			case 'linkReference':
				return rewritePhrasing(node.children, dropped);

			// Strikethrough carries contract text in its decoration; unwrap it
			// rather than discard what it wraps.
			case 'delete':
				return rewritePhrasing(node.children, dropped);

			// Inline code becomes a text node carrying its literal value. It must
			// not become a paragraph, which would put a block inside phrasing.
			case 'inlineCode':
				return [{ type: 'text', value: node.value }];

			default:
				return [];
		}
	});
}

function rewriteListItem(item: ListItem, dropped: Set<string>): ListItem {
	// A list item's children are block content, which `rewriteBlock` handles;
	// the cast is only to widen to and narrow back from `RootContent`.
	const children = rewriteBlock(item.children, dropped) as ListItem['children'];
	return { ...item, children };
}

function rewriteTable(table: Table, dropped: Set<string>): RootContent[] {
	return table.children.flatMap((row) => rewriteTableRow(row, dropped));
}

/**
 * One paragraph per row, cells joined — a table's information is the row, and a
 * row read aloud is a sentence. Cells run through the rewrite rather than
 * straight to text so that a link or an image inside one is reported in
 * `dropped` instead of vanishing unnamed.
 */
function rewriteTableRow(row: TableRow, dropped: Set<string>): RootContent[] {
	dropped.add('tableRow');

	const cells = row.children
		.flatMap((cell) => rewriteTableCell(cell, dropped))
		.map((node) => textOfNode(node))
		.filter((text) => text.length > 0);

	if (cells.length === 0) return [];
	return [{ type: 'paragraph', children: [{ type: 'text', value: cells.join(' — ') }] }];
}

function rewriteTableCell(
	cell: TableCell,
	dropped: Set<string>
): (RootContent | PhrasingContent)[] {
	dropped.add('tableCell');
	if (!cell.children) return [];

	return (cell.children as RootContent[]).flatMap((child) =>
		BLOCK_IN_CELL.has(child.type)
			? rewriteBlock([child], dropped)
			: rewritePhrasing([child as PhrasingContent], dropped)
	);
}

function textOfNode(node: RootContent | PhrasingContent): string {
	if ('value' in node && typeof node.value === 'string') return node.value;
	if (!('children' in node)) return '';

	const children = node.children as (RootContent | PhrasingContent)[];
	return children.map((child) => textOfNode(child)).join('');
}
