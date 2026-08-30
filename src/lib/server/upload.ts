import { PDFDocument } from 'pdf-lib';

export interface UploadedFile {
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export class UploadRejected extends Error {}

export interface UploadLimits {
	maxBytes: number;
	allowedTypes: readonly string[];
}

/**
 * Validates one multipart field into bytes. Type and size are checked before
 * anything is read into memory beyond what the platform already buffered, and
 * the filename is reduced to its basename — it is display metadata and a
 * Content-Disposition value, never a path.
 */
export async function readUpload(
	form: FormData,
	field: string,
	limits: UploadLimits
): Promise<UploadedFile> {
	const value = form.get(field);

	if (!(value instanceof File) || value.size === 0) {
		throw new UploadRejected('No file was uploaded.');
	}

	if (value.size > limits.maxBytes) {
		throw new UploadRejected(
			`File is too large: ${value.size} bytes, limit ${limits.maxBytes} bytes.`
		);
	}

	if (!limits.allowedTypes.includes(value.type)) {
		throw new UploadRejected(
			`Unsupported file type "${value.type}". Allowed: ${limits.allowedTypes.join(', ')}.`
		);
	}

	return {
		filename: value.name.split(/[\\/]/).pop() || 'file',
		contentType: value.type,
		bytes: new Uint8Array(await value.arrayBuffer())
	};
}

/**
 * Refuses a PDF with more pages than the deployment will watermark.
 *
 * `MAX_UPLOAD_MB` bounds bytes, which is not the dimension the cost tracks.
 * Measured at that ceiling: 25 MB across 16,200 pages takes 9.1s and 1.4 GB of
 * resident memory to stamp once, while the same 25 MB across 100 pages takes
 * 0.4s and 77 MB — gated delivery buffers the whole document because pdf-lib
 * does (see `stampPdf`), so a page count is the only bound that limits what one
 * download can cost. Two concurrent downloads of the first file would exhaust a
 * 2 GB container.
 *
 * Bytes that will not parse are refused here too: a document we cannot open is
 * one we cannot prove we stamped, and an unstamped gated download is worse than
 * a refused upload.
 */
export async function assertPdfPages(bytes: Uint8Array, maxPages: number): Promise<void> {
	let pages: number;
	try {
		pages = (await PDFDocument.load(bytes)).getPageCount();
	} catch {
		throw new UploadRejected('This file could not be read as a PDF.');
	}

	if (pages > maxPages) {
		throw new UploadRejected(`PDF has too many pages: ${pages}, limit ${maxPages}.`);
	}
}
