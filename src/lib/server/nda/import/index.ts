import { UploadRejected, type UploadedFile } from '../../upload';
import { docxToMarkdown } from './docx';
import { pdfToMarkdown } from './pdf';

/** What the version editor's import control accepts. */
export const IMPORT_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

export interface ImportedBody {
	markdown: string;
	/** Node types the conversion removed or rewrote; empty for a clean import. */
	dropped: string[];
}

/**
 * The one thing a route imports. Which library reads which format is this
 * module's business, and keeping it here is what stops `pdfjs-dist` and
 * `mammoth` from being named in a route — §10.4 confines both to the admin
 * side, and a route is where that boundary is easiest to lose.
 *
 * Nothing here writes. §5.5 makes import a drafting aid whose output a human
 * reads before `?/saveBody` stores it (P3.22).
 */
export async function importAgreementBody(file: UploadedFile): Promise<ImportedBody> {
	if (file.contentType === 'application/pdf') {
		return { markdown: await pdfToMarkdown(file.bytes), dropped: [] };
	}

	if (file.contentType === IMPORT_TYPES[1]) {
		return docxToMarkdown(file.bytes);
	}

	throw new UploadRejected(`Cannot import a file of type "${file.contentType}".`);
}
