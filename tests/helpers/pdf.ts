import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

/** A real, loadable PDF — `stampPdf` refuses anything it cannot parse. */
export async function blankPdf(pages = 1): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	for (let index = 0; index < pages; index++) pdf.addPage([595, 842]);
	pdf.setTitle('fixture');
	return pdf.save();
}

/**
 * The text a PDF actually draws on its pages. It never appears literally in the
 * saved bytes: pdf-lib Flate-compresses every content stream and writes
 * standard-font text as hex strings. So inflate the streams, then decode the
 * `<hex> Tj` operators. A grep over the raw bytes would silently pass for a
 * stamper that wrote nothing.
 */
export function drawnText(bytes: Uint8Array): string {
	const buf = Buffer.from(bytes);
	const streams: string[] = [];
	let index = 0;

	for (;;) {
		const start = buf.indexOf('stream', index);
		if (start === -1) break;
		const end = buf.indexOf('endstream', start);
		if (end === -1) break;

		let from = start + 'stream'.length;
		if (buf[from] === 0x0d) from++;
		if (buf[from] === 0x0a) from++;

		try {
			streams.push(inflateSync(buf.subarray(from, end)).toString('latin1'));
		} catch {
			// Not a Flate stream — nothing this helper needs to read.
		}
		index = end + 'endstream'.length;
	}

	return [...streams.join('\n').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
		.map((match) => Buffer.from(match[1]!, 'hex').toString('latin1'))
		.join('\n');
}
