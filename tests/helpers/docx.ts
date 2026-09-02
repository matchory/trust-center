import { crc32 } from 'node:zlib';

const DOCUMENT_XML_HEADER =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';

const CONTENT_TYPES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="xml" ContentType="application/xml"/>' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
	'</Types>';

const RELS =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
	'</Relationships>';

/**
 * A minimal but genuinely valid .docx — three parts in a ZIP. Written by hand
 * rather than with a library because the alternative is a binary fixture nobody
 * can read in a diff, and because a DOCX is only a ZIP of three XML files when
 * nothing in it is styled beyond a heading.
 */
export function docxWith(paragraphs: readonly { text: string; heading?: boolean }[]): Uint8Array {
	const body = paragraphs
		.map((paragraph) => {
			const style = paragraph.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : '';
			return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
		})
		.join('');

	return zipStored([
		{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
		{ name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
		{
			name: 'word/document.xml',
			data: Buffer.from(`${DOCUMENT_XML_HEADER}${body}</w:body></w:document>`, 'utf8')
		}
	]);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

interface ZipEntry {
	name: string;
	data: Buffer;
}

/** Store-only ZIP: no compression, so there is no deflate stream to get wrong. */
function zipStored(entries: readonly ZipEntry[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const sum = crc32(entry.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(sum, 16);
		central.writeUInt32LE(entry.data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);

		locals.push(local, name, entry.data);
		centrals.push(central, name);
		offset += local.length + name.length + entry.data.length;
	}

	const central = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);

	return new Uint8Array(Buffer.concat([...locals, central, end]));
}
