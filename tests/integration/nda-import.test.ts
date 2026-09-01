import { describe, expect, it } from 'vitest';
import { importAgreementBody } from '../../src/lib/server/nda/import';
import { PdfHasNoText } from '../../src/lib/server/nda/import/pdf';
import { blankPdf, textPdf } from '../helpers/pdf';

describe('agreement import', () => {
	it('names a scan rather than importing an empty body', async () => {
		await expect(
			importAgreementBody({
				filename: 'scan.pdf',
				contentType: 'application/pdf',
				bytes: await blankPdf()
			})
		).rejects.toBeInstanceOf(PdfHasNoText);
	});

	it('imports a pdf into markdown the subset accepts', async () => {
		const imported = await importAgreementBody({
			filename: 'nda.pdf',
			contentType: 'application/pdf',
			bytes: await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: '1. Definitionen.', size: 11 }
			])
		});

		expect(imported.markdown).toContain('Vertraulichkeitsvereinbarung');
	});
});
