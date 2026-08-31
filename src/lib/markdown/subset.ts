import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

/**
 * Spec §5.1: headings, paragraphs, bold, italic, ordered and unordered lists,
 * and horizontal rules. Nothing else.
 *
 * `text` and `break` are here because they are what the leaves of the above
 * actually are; `listItem` because a list is not a flat node.
 *
 * Tables are absent from this list and are *not* enforced by it: `remark-gfm`
 * is deliberately not installed, so a pipe table parses as paragraph text and
 * never becomes a `table` node. Installing GFM later would silently widen the
 * subset without changing a line of this file.
 */
export const SUBSET_NODE_TYPES = [
	'root',
	'heading',
	'paragraph',
	'text',
	'strong',
	'emphasis',
	'break',
	'list',
	'listItem',
	'thematicBreak'
] as const;

export type SubsetNodeType = (typeof SUBSET_NODE_TYPES)[number];

const ALLOWED = new Set<string>(SUBSET_NODE_TYPES);

/**
 * Raised at save time rather than at render time — the same discipline as
 * `RULE_PATTERN` refusing a rule that could never match. A body that cannot be
 * rendered must not become a version somebody is asked to sign.
 */
export class MarkdownNotInSubset extends Error {
	readonly nodeType: string;

	constructor(nodeType: string) {
		super(`Markdown node type not permitted in an agreement body: ${nodeType}`);
		this.name = 'MarkdownNotInSubset';
		this.nodeType = nodeType;
	}
}

const processor = unified().use(remarkParse);

function assertSubset(node: { type: string }): void {
	if (!ALLOWED.has(node.type)) throw new MarkdownNotInSubset(node.type);

	const children = (node as { children?: RootContent[] }).children;
	if (!Array.isArray(children)) return;
	for (const child of children) assertSubset(child);
}

/**
 * Parses to mdast and refuses anything outside the subset. The AST is the
 * canonical form: the click-through, the preview and the record PDF all render
 * from it and never from raw passthrough, which is why this phase has no HTML
 * sanitisation step anywhere — there is no untrusted HTML.
 */
export function parseAgreementBody(markdown: string): Root {
	const root = processor.parse(markdown) as Root;
	assertSubset(root);
	return root;
}

export function isInSubset(markdown: string): boolean {
	try {
		parseAgreementBody(markdown);
		return true;
	} catch (cause) {
		if (cause instanceof MarkdownNotInSubset) return false;
		throw cause;
	}
}
