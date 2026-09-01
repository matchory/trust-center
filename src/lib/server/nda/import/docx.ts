import mammoth from 'mammoth';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Root } from 'mdast';
import { downgradeToSubset } from '../../../markdown/downgrade';

const toMdast = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark);
const serializer = unified().use(remarkStringify, { bullet: '-', rule: '-' });

/**
 * DOCX → semantic HTML → mdast → the subset → Markdown.
 *
 * The middle two steps are the unified family `remark-parse` already belongs
 * to, rather than a string-based converter such as turndown: §13 chose a shared
 * AST so the validator, the renderer, the PDF layout and the editor agree
 * rather than approximately agree, and that argument covers the import path too
 * (P3.23).
 *
 * `dropped` names what the downgrade removed, so the author is told at the
 * moment they can still fix it — a real contract carries links and tables, and
 * refusing the document for containing one would make this useless on exactly
 * the input it exists for.
 */
export async function docxToMarkdown(
	bytes: Uint8Array
): Promise<{ markdown: string; dropped: string[] }> {
	const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });

	const parsed = toMdast.runSync(toMdast.parse(html)) as Root;
	const { root, dropped } = downgradeToSubset(parsed);

	return { markdown: serializer.stringify(root), dropped };
}
