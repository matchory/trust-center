import { degrees, PDFDocument, rgb } from 'pdf-lib';
import { embedFaces } from '../pdf/fonts';

export interface WatermarkRecipient {
	name: string;
	company: string;
	email: string;
	at: Date;
	/** Localized confidentiality notice, rendered in the requester's locale. */
	notice: string;
}

/**
 * Loads, stamps every page, and re-saves. This is why gated delivery buffers
 * rather than streams (spec §6.5): pdf-lib holds the whole document in memory.
 * The bound is MAX_UPLOAD_MB, the same ceiling that admitted the file.
 *
 * The stamp is page content rather than document metadata, because metadata is
 * trivially stripped and invisible in most viewers — a watermark that does not
 * survive a casual re-save is not evidence of anything.
 */
export async function stampPdf(
	bytes: Uint8Array,
	fontDir: string,
	recipient: WatermarkRecipient
): Promise<Uint8Array> {
	// `ignoreEncryption` is deliberately NOT set: a document we cannot fully
	// parse is one we cannot prove we stamped, and a silently unstamped gated
	// download is worse than a failed one.
	const pdf = await PDFDocument.load(bytes);
	// The same embedded faces the record PDF draws with. A standard font is
	// WinAnsi-only, and the name it could not encode is exactly the one this
	// stamp exists to carry.
	const faces = await embedFaces(pdf, fontDir);
	const font = faces.regular;

	const timestamp = `${recipient.at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
	const footer = `${recipient.name} · ${recipient.company} · ${recipient.email} · ${timestamp}`;
	const band = recipient.company;
	const notice = recipient.notice;

	for (const page of pdf.getPages()) {
		const { width, height } = page.getSize();

		// A diagonal, low-opacity band across the middle: survives cropping the
		// margins, which is the obvious way to remove a footer.
		page.drawText(band, {
			x: width * 0.12,
			y: height * 0.42,
			size: 42,
			font,
			color: rgb(0.6, 0.6, 0.6),
			opacity: 0.18,
			rotate: degrees(30)
		});

		// The identifying line, small and along the bottom margin.
		page.drawText(footer, {
			x: 28,
			y: 22,
			size: 7,
			font,
			color: rgb(0.25, 0.25, 0.25),
			opacity: 0.85
		});

		page.drawText(notice, {
			x: 28,
			y: 12,
			size: 7,
			font,
			color: rgb(0.25, 0.25, 0.25),
			opacity: 0.85
		});
	}

	return pdf.save();
}
