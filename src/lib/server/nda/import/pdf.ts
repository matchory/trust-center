import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';
// pdfjs-dist ships several builds and the legacy one is the only one that runs
// under Node without a browser worker; the others reach for `DOMMatrix` and
// friends on import and fail before `getDocument` is ever called.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * A PDF that yields no text is a scan, and §5.5 refuses it by name rather than
 * importing an empty body somebody then has to explain.
 */
export class PdfHasNoText extends Error {
	constructor() {
		super('This PDF contains no extractable text — it is probably a scan.');
		this.name = 'PdfHasNoText';
	}
}

/**
 * §16 asks for these to be named rather than inlined, because they are the
 * part of this file most likely to be wrong on the first real contract and the
 * cheapest thing to correct when it is.
 */
/** Two points of drift still counts as the same baseline. */
const LINE_TOLERANCE_PT = 2;
/** A vertical gap wider than this many line-heights starts a new paragraph. */
const PARAGRAPH_GAP_RATIO = 1.8;
/** Bigger than the body by this much is a heading. */
const HEADING_SIZE_RATIO = 1.15;
/** Bigger than the body by this much is the document's title. */
const TITLE_SIZE_RATIO = 1.5;

interface Line {
	text: string;
	size: number;
	/** Distance from this line's baseline down to the next one, in points. */
	gapBelow: number;
}

const serializer = unified().use(remarkStringify, { bullet: '-', rule: '-' });

/**
 * Positioned runs in, canonical Markdown out. A PDF carries no headings, no
 * lists and no paragraph boundaries — only glyphs at coordinates — so
 * everything here is reconstruction, and §5.5 bounds how much of it we attempt.
 */
export async function pdfToMarkdown(bytes: Uint8Array): Promise<string> {
	const lines = await extractLines(bytes);
	if (lines.length === 0) throw new PdfHasNoText();

	const body = bodySize(lines);
	const children: RootContent[] = [];
	let paragraph: string[] = [];

	const flush = (): void => {
		if (paragraph.length === 0) return;
		children.push({ type: 'paragraph', children: [{ type: 'text', value: paragraph.join(' ') }] });
		paragraph = [];
	};

	for (const line of lines) {
		if (line.size >= body * HEADING_SIZE_RATIO) {
			flush();
			children.push({
				type: 'heading',
				depth: line.size >= body * TITLE_SIZE_RATIO ? 1 : 2,
				children: [{ type: 'text', value: line.text }]
			});
			continue;
		}

		paragraph.push(line.text);
		if (line.gapBelow > line.size * PARAGRAPH_GAP_RATIO) flush();
	}

	flush();

	const root: Root = { type: 'root', children };

	// `remark-stringify` escapes a paragraph beginning `1. ` as `1\. `, which is
	// what keeps an enumerated clause out of an ordered list on the way back in
	// (P3.21). The rule is the serializer's, not a check a later edit could drop.
	return serializer.stringify(root);
}

interface PositionedItem {
	str: string;
	transform: number[];
	height: number;
}

async function extractLines(bytes: Uint8Array): Promise<Line[]> {
	// `useSystemFonts: false` because glyph positions are all we read and font
	// loading is cost without a reader. There is deliberately no
	// `isEvalSupported: false` beside it, which this file would otherwise want
	// against an operator-supplied document: pdfjs-dist 6 removed the option
	// along with the eval path it guarded, and passing it now fails typecheck.
	//
	// The loading task, not the document proxy, is what owns teardown: as of
	// pdfjs-dist 6 the proxy has only `cleanup()`, and calling `destroy()` on it
	// throws. Holding the task is what lets the worker be torn down at all.
	const task = getDocument({ data: bytes, useSystemFonts: false });

	const lines: Line[] = [];

	try {
		const pdf = await task.promise;
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			lines.push(...groupIntoLines(content.items as PositionedItem[]));
		}
	} finally {
		await task.destroy();
	}

	return lines;
}

/** Items sharing a baseline become one line, left to right, top-down. */
function groupIntoLines(items: readonly PositionedItem[]): Line[] {
	const drawn = items.filter((item) => item.str.trim().length > 0);
	if (drawn.length === 0) return [];

	const sorted = [...drawn].sort((left, right) => {
		const dy = right.transform[5]! - left.transform[5]!;
		return Math.abs(dy) > LINE_TOLERANCE_PT ? dy : left.transform[4]! - right.transform[4]!;
	});

	const grouped: { y: number; size: number; parts: string[] }[] = [];

	for (const item of sorted) {
		const y = item.transform[5]!;
		const last = grouped.at(-1);

		if (last && Math.abs(last.y - y) <= LINE_TOLERANCE_PT) {
			last.parts.push(item.str);
			last.size = Math.max(last.size, item.height);
			continue;
		}

		grouped.push({ y, size: item.height, parts: [item.str] });
	}

	return grouped.map((line, index) => ({
		text: line.parts.join('').replace(/\s+/g, ' ').trim(),
		size: line.size,
		// The last line of a page has no measurable gap; treating it as infinite
		// ends the paragraph there, which is right at a page boundary and
		// harmless in the middle of one.
		gapBelow: grouped[index + 1] ? line.y - grouped[index + 1]!.y : Number.POSITIVE_INFINITY
	}));
}

/** The most common line size, which is the body text of any real contract. */
function bodySize(lines: readonly Line[]): number {
	const counts = new Map<number, number>();
	for (const line of lines) {
		const size = Math.round(line.size * 2) / 2;
		counts.set(size, (counts.get(size) ?? 0) + 1);
	}

	let best = 0;
	let seen = -1;
	for (const [size, count] of counts) {
		// A tie goes to the smaller size, because a title never outnumbers the
		// body it titles. Without that rule a document short enough for its
		// heading to tie with its body — an excerpt, a one-clause amendment —
		// takes the heading as the body and then nothing clears the heading
		// ratio, so the import comes back as one flat run of paragraphs.
		if (count > seen || (count === seen && size < best)) {
			best = size;
			seen = count;
		}
	}

	return best;
}
