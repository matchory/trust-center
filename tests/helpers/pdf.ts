import {
	decodePDFRawStream,
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFRawStream,
	StandardFonts,
	type PDFPageLeaf
} from 'pdf-lib';

/** A real, loadable PDF — `stampPdf` refuses anything it cannot parse. */
export async function blankPdf(pages = 1): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	for (let index = 0; index < pages; index++) pdf.addPage([595, 842]);
	pdf.setTitle('fixture');
	return pdf.save();
}

/**
 * A PDF whose pages actually carry text, laid out top-down so the import
 * extractor sees the vertical gaps it groups on. `size` is what makes a line a
 * heading: the grouper decides on size relative to the body text, so a fixture
 * has to vary it or every line reads as body.
 */
export async function textPdf(
	lines: readonly { text: string; size: number }[]
): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([595, 842]);

	let y = 800;
	for (const line of lines) {
		page.drawText(line.text, { x: 50, y, size: line.size, font });
		y -= line.size * 1.6;
	}

	return pdf.save();
}

/**
 * The text a PDF actually draws on its pages, one drawn run per line.
 *
 * None of it appears literally in the saved bytes. pdf-lib Flate-compresses
 * every content stream, and an embedded font is written with Identity-H
 * encoding: `Tj` carries glyph indices into that one subset, not characters —
 * `Łukasz` is `<0001000200030004000500060007>`. So the only honest way to read
 * a page back is the way a viewer does it: follow `Tf` to the font in the
 * page's resources, and run its `ToUnicode` CMap over the codes. A grep over
 * the raw bytes, or one CMap applied to every font, would report confident
 * nonsense — and the strings under test here are the typed names standing in
 * for signatures.
 */
export async function drawnText(bytes: Uint8Array): Promise<string> {
	const pdf = await PDFDocument.load(bytes);
	return pdf
		.getPages()
		.map((page) => decodePage(page.node))
		.filter((text) => text.length > 0)
		.join('\n');
}

/** Code → string for one font, or `undefined` for a single-byte simple font. */
type CMap = Map<number, string> | undefined;

function decodePage(node: PDFPageLeaf): string {
	const fonts = new Map<string, CMap>();
	const resources = node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
	for (const [name, value] of resources?.entries() ?? []) {
		const font = node.context.lookup(value, PDFDict);
		fonts.set(name.asString(), font ? toUnicodeCMap(font) : undefined);
	}

	const runs: string[] = [];
	let current: CMap;

	// `/F1-0 12 Tf` selects a font; `<hex> Tj` draws with whichever is current.
	const operators = /\/([^\s/[\]<>]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj/g;
	for (const match of contentOf(node).matchAll(operators)) {
		if (match[1] !== undefined) current = fonts.get(`/${match[1]}`);
		else runs.push(decodeRun(match[2] ?? '', current));
	}

	return runs.join('\n');
}

function contentOf(node: PDFPageLeaf): string {
	const contents = node.Contents();
	const streams =
		contents instanceof PDFArray
			? contents.asArray().map((ref) => node.context.lookup(ref))
			: [contents];

	return streams
		.filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
		.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
		.join('\n');
}

/**
 * Only `bfchar` is read, not `bfrange`: every PDF this helper sees was written
 * by pdf-lib, which emits nothing else. A file from elsewhere would decode
 * short rather than wrong, and no test feeds it one.
 */
function toUnicodeCMap(font: PDFDict): CMap {
	const stream = font.lookup(PDFName.of('ToUnicode'));
	if (!(stream instanceof PDFRawStream)) return undefined;

	const cmap = new Map<number, string>();
	const source = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
	for (const [, code, target] of source.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
		// CMap targets are UTF-16BE; Node only decodes UTF-16LE, hence the swap.
		cmap.set(parseInt(code!, 16), Buffer.from(target!, 'hex').swap16().toString('utf16le'));
	}
	return cmap;
}

function decodeRun(hex: string, cmap: CMap): string {
	const bytes = Buffer.from(hex, 'hex');

	// A simple font — one of pdf-lib's WinAnsi standard fourteen — writes one
	// byte per character; a composite font writes two-byte codes.
	if (!cmap) return bytes.toString('latin1');

	let text = '';
	for (let index = 0; index + 1 < bytes.length; index += 2) {
		text += cmap.get(bytes.readUInt16BE(index)) ?? '';
	}
	return text;
}
