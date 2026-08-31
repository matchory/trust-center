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
	// Registration is per document, not per process: pdf-lib holds the fontkit
	// instance on the document it embeds into.
	pdf.registerFontkit(fontkit);

	const embed = async (file: string): Promise<PDFFont> =>
		pdf.embedFont(await readFile(join(dir, file)), { subset: true });

	const [regular, bold, italic, boldItalic] = await Promise.all([
		embed(FILES.regular),
		embed(FILES.bold),
		embed(FILES.italic),
		embed(FILES.boldItalic)
	]);

	return { regular, bold, italic, boldItalic };
}
