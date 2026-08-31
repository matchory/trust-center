import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

export interface Faces {
	regular: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
	boldItalic: PDFFont;
}

const FILES = {
	regular: 'regular.ttf',
	bold: 'bold.ttf',
	italic: 'italic.ttf',
	boldItalic: 'bold-italic.ttf'
} as const;

/**
 * The four faces every agreement and every watermark draws with, embedded as
 * subsets so a 400 KB typeface does not become 400 KB of each stored record.
 *
 * A directory rather than four paths, and configurable, because a deployment
 * whose signatories write in a script Source Sans has no glyphs for replaces
 * the four files and changes nothing else. The names are fixed so that swap
 * needs no further configuration.
 */
export async function embedFaces(pdf: PDFDocument, dir: string): Promise<Faces> {
	const [regular, bold, italic, boldItalic] = await Promise.all([
		embedFace(pdf, dir, 'regular'),
		embedFace(pdf, dir, 'bold'),
		embedFace(pdf, dir, 'italic'),
		embedFace(pdf, dir, 'boldItalic')
	]);

	return { regular, bold, italic, boldItalic };
}

/**
 * One face, for a document that draws in one — the watermark is the case, and
 * it stamps every gated download.
 *
 * Embedding is not free: parsing and subsetting the other three costs about
 * 11 ms and 8 KB on every watermarked download, and the stamp would never draw
 * a glyph from any of them.
 */
export async function embedFace(
	pdf: PDFDocument,
	dir: string,
	face: keyof Faces
): Promise<PDFFont> {
	// Registration is per document, not per process: pdf-lib holds the fontkit
	// instance on the document it embeds into. Calling it more than once for the
	// same document is harmless.
	pdf.registerFontkit(fontkit);

	return pdf.embedFont(await readFile(join(dir, FILES[face])), { subset: true });
}
