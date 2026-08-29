import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface WatermarkRecipient {
	name: string;
	company: string;
	email: string;
	at: Date;
	/** Localized confidentiality notice, rendered in the requester's locale. */
	notice: string;
}

/**
 * Helvetica is a PDF standard font with no glyphs beyond WinAnsi, and pdf-lib
 * throws on anything it cannot encode. A name with a CJK character or an emoji
 * would otherwise fail the whole download rather than the stamp — so the text
 * is reduced to what the font can draw, and the unrepresentable part becomes a
 * marker rather than an exception. The identity still comes through: the email
 * address is ASCII by the time it reaches here.
 */
function toWinAnsi(value: string): string {
	return value.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
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
	recipient: WatermarkRecipient
): Promise<Uint8Array> {
	// `ignoreEncryption` is deliberately NOT set: a document we cannot fully
	// parse is one we cannot prove we stamped, and a silently unstamped gated
	// download is worse than a failed one.
	const pdf = await PDFDocument.load(bytes);
	const font = await pdf.embedFont(StandardFonts.Helvetica);

	const timestamp = `${recipient.at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
	const footer = toWinAnsi(
		`${recipient.name} · ${recipient.company} · ${recipient.email} · ${timestamp}`
	);
	const band = toWinAnsi(recipient.company);
	const notice = toWinAnsi(recipient.notice);

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
