import { rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Root, RootContent } from 'mdast';
import type { Faces } from './fonts';

const PAGE: [number, number] = [595, 842];
const MARGIN = { top: 64, bottom: 64, side: 56 };
const BODY = { size: 10.5, leading: 14.5 };
const INDENT = 18;
const HEADING_SIZE = [17, 13.5, 11.5] as const;

export interface LayoutOptions {
	/** Drawn once, above the body, as the document's own title. */
	title: string;
}

/** One styled fragment of a line. Wrapping happens over these, not over nodes. */
interface Piece {
	text: string;
	font: PDFFont;
}

/**
 * Draws an agreement body onto fresh pages of `pdf`.
 *
 * The engine is a cursor walked over the mdast: it never measures a block
 * ahead of time, it asks before every single line whether that line still fits.
 * That is what carries a nested list across a page boundary — the check lives
 * below the list, at the line, so a list is not a unit that can overflow.
 */
export function layoutAgreement(
	pdf: PDFDocument,
	root: Root,
	faces: Faces,
	options: LayoutOptions
): void {
	const cursor = new Cursor(pdf, faces);

	heading([{ text: options.title, font: faces.bold }], cursor, HEADING_SIZE[0], 0);
	blocks(root.children, cursor, 0);
}

class Cursor {
	private page: PDFPage;
	private y: number;

	/** A list marker waiting for the line it belongs beside. */
	private marker: { text: string; x: number } | undefined;

	constructor(
		private readonly pdf: PDFDocument,
		readonly faces: Faces
	) {
		this.page = pdf.addPage(PAGE);
		this.y = PAGE[1] - MARGIN.top;
	}

	get width(): number {
		return PAGE[0] - MARGIN.side * 2;
	}

	/** Vertical space, collapsed at the top of a page so blocks do not sag. */
	space(amount: number): void {
		if (this.y < PAGE[1] - MARGIN.top) this.y -= amount;
	}

	/** Break first if `height` would not fit. Called before drawing, never after. */
	fit(height: number): void {
		if (this.y - height >= MARGIN.bottom) return;
		this.page = this.pdf.addPage(PAGE);
		this.y = PAGE[1] - MARGIN.top;
	}

	/** Places `text` on the next line drawn, at `x`, rather than on its own. */
	pendMarker(text: string, x: number): void {
		this.marker = { text, x };
	}

	line(pieces: Piece[], size: number, leading: number, indent: number): void {
		this.fit(leading);

		let x = MARGIN.side + indent;
		if (this.marker) {
			this.page.drawText(this.marker.text, {
				x: MARGIN.side + this.marker.x,
				y: this.y - size,
				size,
				font: this.faces.regular
			});
			this.marker = undefined;
		}

		// Wrapping splits a line into one piece per word; drawing it that way
		// would emit a text operator per word and leave the words unjoinable to
		// anything reading the page back. Adjacent pieces in one face are one run.
		for (const run of merge(pieces)) {
			this.page.drawText(run.text, { x, y: this.y - size, size, font: run.font });
			x += run.font.widthOfTextAtSize(run.text, size);
		}

		this.y -= leading;
	}

	rule(): void {
		this.space(BODY.leading);
		this.fit(BODY.leading);
		this.page.drawLine({
			start: { x: MARGIN.side, y: this.y },
			end: { x: PAGE[0] - MARGIN.side, y: this.y },
			thickness: 0.5,
			color: rgb(0.75, 0.75, 0.75)
		});
		this.y -= BODY.leading;
	}
}

function merge(pieces: Piece[]): Piece[] {
	const runs: Piece[] = [];
	for (const piece of pieces) {
		const last = runs.at(-1);
		if (last?.font === piece.font) last.text += piece.text;
		else runs.push({ ...piece });
	}
	return runs;
}

function face(faces: Faces, bold: boolean, italic: boolean): PDFFont {
	if (bold && italic) return faces.boldItalic;
	if (bold) return faces.bold;
	if (italic) return faces.italic;
	return faces.regular;
}

/** Flattens inline nodes to styled pieces; `\n` marks a hard break. */
function pieces(nodes: RootContent[], faces: Faces, bold = false, italic = false): Piece[] {
	const out: Piece[] = [];
	for (const node of nodes) {
		if (node.type === 'text') out.push({ text: node.value, font: face(faces, bold, italic) });
		else if (node.type === 'strong') out.push(...pieces(node.children, faces, true, italic));
		else if (node.type === 'emphasis') out.push(...pieces(node.children, faces, bold, true));
		else if (node.type === 'break') out.push({ text: '\n', font: face(faces, bold, italic) });
	}
	return out;
}

/**
 * Wraps styled pieces onto lines, carrying `x` across a run boundary so a bold
 * word mid-sentence does not restart the line.
 */
function wrap(
	source: Piece[],
	cursor: Cursor,
	size: number,
	leading: number,
	indent: number
): void {
	const available = cursor.width - indent;
	let line: Piece[] = [];
	let width = 0;

	const flush = (): void => {
		if (line.length > 0) cursor.line(line, size, leading, indent);
		line = [];
		width = 0;
	};

	for (const piece of source) {
		for (const token of piece.text.split(/(\s+)/)) {
			if (token.length === 0) continue;
			if (token === '\n') {
				flush();
				continue;
			}

			const blank = /^\s+$/.test(token);
			// A space that would start a line is the wrap point itself, not text.
			if (blank && line.length === 0) continue;

			const text = blank ? ' ' : token;
			const advance = piece.font.widthOfTextAtSize(text, size);
			if (!blank && width + advance > available && line.length > 0) flush();

			line.push({ text, font: piece.font });
			width += advance;
		}
	}

	flush();
}

function blocks(nodes: RootContent[], cursor: Cursor, indent: number): void {
	for (const node of nodes) {
		if (node.type === 'heading') {
			const size = HEADING_SIZE[Math.min(node.depth, HEADING_SIZE.length) - 1]!;
			heading(pieces(node.children, cursor.faces, true), cursor, size, indent);
		} else if (node.type === 'paragraph') {
			cursor.space(BODY.leading * 0.5);
			wrap(pieces(node.children, cursor.faces), cursor, BODY.size, BODY.leading, indent);
		} else if (node.type === 'list') {
			cursor.space(BODY.leading * 0.4);
			listItems(node, cursor, indent);
		} else if (node.type === 'thematicBreak') {
			cursor.rule();
		}
	}
}

function listItems(
	node: Extract<RootContent, { type: 'list' }>,
	cursor: Cursor,
	indent: number
): void {
	const start = node.start ?? 1;

	node.children.forEach((item, index) => {
		if (item.type !== 'listItem') return;

		// The marker is pended rather than drawn: the item's first line has not
		// been laid out yet, and it may land on the next page.
		cursor.pendMarker(node.ordered ? `${start + index}.` : '–', indent);
		blocks(item.children, cursor, indent + INDENT);
	});
}

/**
 * A heading takes two body lines with it or moves overleaf: one alone at the
 * foot of a page changes what the clause overleaf appears to govern.
 */
function heading(source: Piece[], cursor: Cursor, size: number, indent: number): void {
	cursor.space(size * 0.9);
	cursor.fit(size * 1.5 + BODY.leading * 2);
	wrap(source, cursor, size, size * 1.5, indent);
}
