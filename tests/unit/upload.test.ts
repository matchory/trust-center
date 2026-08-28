import { describe, expect, it } from 'vitest';
import { readUpload } from '../../src/lib/server/upload';

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
