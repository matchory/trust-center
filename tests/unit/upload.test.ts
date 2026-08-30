import { describe, expect, it } from 'vitest';
import { assertPdfPages, readUpload } from '../../src/lib/server/upload';
import { blankPdf } from '../helpers/pdf';

function formWith(file: File): FormData {
	const data = new FormData();
	data.set('file', file);
	return data;
}

const opts = { maxBytes: 1024, allowedTypes: ['application/pdf'] };

describe('readUpload', () => {
	it('accepts an allowed type within the size limit', async () => {
		const file = new File([new Uint8Array(10)], 'avv.pdf', { type: 'application/pdf' });

		const upload = await readUpload(formWith(file), 'file', opts);

		expect(upload.filename).toBe('avv.pdf');
		expect(upload.contentType).toBe('application/pdf');
		expect(upload.bytes.byteLength).toBe(10);
	});

	it('rejects a file over the limit', async () => {
		const file = new File([new Uint8Array(2048)], 'big.pdf', { type: 'application/pdf' });

		await expect(readUpload(formWith(file), 'file', opts)).rejects.toThrow(/too large/i);
	});

	it('rejects a disallowed content type', async () => {
		const file = new File([new Uint8Array(10)], 'x.html', { type: 'text/html' });

		await expect(readUpload(formWith(file), 'file', opts)).rejects.toThrow(/type/i);
	});

	it('rejects an empty field', async () => {
		await expect(readUpload(new FormData(), 'file', opts)).rejects.toThrow(/no file/i);
	});

	it('strips any path from the reported filename', async () => {
		// The filename is display metadata and a Content-Disposition value; it
		// never reaches a filesystem path, but a browser-supplied "../" in it
		// has no business surviving either.
		const file = new File([new Uint8Array(4)], '../../etc/passwd.pdf', {
			type: 'application/pdf'
		});

		expect((await readUpload(formWith(file), 'file', opts)).filename).toBe('passwd.pdf');
	});
});

describe('assertPdfPages', () => {
	it('accepts a document within the page limit', async () => {
		await expect(assertPdfPages(await blankPdf(3), 10)).resolves.toBeUndefined();
	});

	it('rejects a document over the page limit', async () => {
		// The cost of watermarking tracks page count, not bytes: at the
		// MAX_UPLOAD_MB ceiling, 16,200 pages cost 9.1s and 1.4 GB of resident
		// memory to serve once, while 100 pages of the same size cost 0.4s and
		// 77 MB. A byte limit alone admits the first one.
		await expect(assertPdfPages(await blankPdf(12), 10)).rejects.toThrow(/pages/i);
	});

	it('rejects bytes it cannot parse as a PDF', async () => {
		// A file we cannot open is one we cannot stamp, and an unstamped gated
		// download is worse than a refused upload.
		await expect(assertPdfPages(new Uint8Array([1, 2, 3]), 10)).rejects.toThrow(/pdf/i);
	});
});
