import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { parseAgreementBody } from '../../markdown/subset';
import { m } from '../../paraglide/messages.js';
import { assertIsLocale } from '../../paraglide/runtime.js';
import { ndaAcceptance } from '../db/schema';
import { embedFaces } from '../pdf/fonts';
import { layoutAgreement } from '../pdf/layout';
import { newStorageKey } from '../storage';
import type { Db } from '../db';
import type { StorageAdapter } from '../storage';

export interface RecordInput {
	/** The four faces, from config. Passed in, like every other module below a route. */
	fontDir: string;
	/** The agreement's name in the signatory's locale. */
	title: string;
	version: number;
	bodyMd: string;
	typedName: string;
	email: string;
	company: string;
	acceptedAt: Date;
	ip: string | null;
	/** The hash of the accepted bytes, drawn in full. */
	sha256: string;
	/** The signatory's locale — the record is written in the language they read. */
	locale: string;
}

/**
 * §10.2. The evidence, rendered: what the agreement was, the text as it stood,
 * and who accepted it from where and when.
 *
 * The hash is drawn in full rather than truncated. A hash you cannot compare is
 * decoration, and comparing is the only thing this line is for.
 */
export async function renderRecord(input: RecordInput): Promise<Uint8Array> {
	const locale = assertIsLocale(input.locale);
	const pdf = await PDFDocument.create();
	const faces = await embedFaces(pdf, input.fontDir);

	layoutAgreement(pdf, parseAgreementBody(input.bodyMd), faces, {
		title: m.record_title({ name: input.title }, { locale }),
		lead: m.record_intro({ version: input.version }, { locale }),
		closing: {
			heading: m.record_acceptance_heading({}, { locale }),
			fields: [
				{ label: m.record_field_name({}, { locale }), value: input.typedName },
				{ label: m.record_field_email({}, { locale }), value: input.email },
				{ label: m.record_field_company({}, { locale }), value: input.company },
				{
					label: m.record_field_accepted_at({}, { locale }),
					// UTC, spelled out: a record read in another timezone years later
					// must not be ambiguous about when it was signed.
					value: `${input.acceptedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
				},
				{
					label: m.record_field_ip({}, { locale }),
					value: input.ip ?? m.record_field_unknown({}, { locale })
				},
				{ label: m.record_field_hash({}, { locale }), value: input.sha256 }
			]
		}
	});

	pdf.setTitle(m.record_title({ name: input.title }, { locale }));
	return pdf.save();
}

/**
 * Stores the rendered bytes and points the acceptance at them.
 *
 * The put comes first, deliberately, and neither half is wrapped with anything
 * else: if storage succeeds and the update fails the object is orphaned, which
 * costs disk. The other order would leave the row naming an object that does
 * not exist — a record that says the evidence is filed when it is not.
 */
export async function storeRecord(
	db: Db,
	storage: StorageAdapter,
	acceptanceId: string,
	bytes: Uint8Array
): Promise<string> {
	const key = newStorageKey();
	await storage.put(key, bytes);

	await db
		.update(ndaAcceptance)
		.set({ recordPdfKey: key })
		.where(eq(ndaAcceptance.id, acceptanceId));

	return key;
}
