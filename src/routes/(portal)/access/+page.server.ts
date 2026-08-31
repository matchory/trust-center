import { redirect } from '@sveltejs/kit';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { localizePath } from '$lib/i18n/locale';
import { grantedDocuments } from '$lib/server/access/grants';
import { getConfig } from '$lib/server/config';
import { outstandingAgreements } from '$lib/server/nda/acceptance';
import { acceptanceScope } from '$lib/server/nda/settings';
import { getDb } from '$lib/server/db/instance';
import {
	document,
	documentFile,
	documentTranslation,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateTranslation,
	ndaTemplateVersion
} from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// The layout guard already sent an anonymous visitor to the request form.
	// This is that guarantee restated for the type checker, not a second policy.
	const requester = locals.requester;
	if (!requester) redirect(303, localizePath('/request', locals.locale));

	const db = getDb();
	const config = getConfig();
	const granted = await grantedDocuments(db, requester.id, { locales: config.locales });

	// What they still owe. Without this a requester whose grant is waiting on an
	// acceptance lands here, sees an empty page, and has no way to learn that one
	// step is left — the approval mail is the only place it was ever said.
	const outstanding = await outstandingAgreements(db, requester.id, {
		locales: config.locales,
		locale: locals.locale,
		scope: await acceptanceScope(db)
	});

	// Listed whatever the state of their grants: a record is evidence of what
	// they signed, and it outlives the access it was signed for.
	const records = await db
		.select({
			acceptanceId: ndaAcceptance.id,
			acceptedAt: ndaAcceptance.acceptedAt,
			slug: ndaTemplate.slug,
			version: ndaTemplateVersion.version,
			name: ndaTemplateTranslation.name
		})
		.from(ndaAcceptance)
		.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaAcceptance.versionId))
		.innerJoin(ndaTemplate, eq(ndaTemplate.id, ndaTemplateVersion.templateId))
		.leftJoin(
			ndaTemplateTranslation,
			and(
				eq(ndaTemplateTranslation.templateId, ndaTemplate.id),
				eq(ndaTemplateTranslation.locale, locals.locale)
			)
		)
		.where(and(eq(ndaAcceptance.requesterId, requester.id), isNotNull(ndaAcceptance.recordPdfKey)))
		.orderBy(desc(ndaAcceptance.acceptedAt));

	const acceptanceRecords = records.map((row) => ({ ...row, name: row.name ?? row.slug }));

	if (granted.length === 0) {
		return { documents: [], expiresAt: null, records: acceptanceRecords, outstanding };
	}

	const rows = await db
		.select({
			documentId: document.id,
			slug: document.slug,
			title: documentTranslation.title,
			summary: documentTranslation.summary,
			fileId: documentFile.id,
			filename: documentFile.filename,
			version: documentFile.version,
			validUntil: documentFile.validUntil
		})
		.from(document)
		.leftJoin(
			documentTranslation,
			and(
				eq(documentTranslation.documentId, document.id),
				eq(documentTranslation.locale, locals.locale)
			)
		)
		// The current file for the viewer's locale. Grants reference the
		// *document*, so a holder always receives the current version — spec §9's
		// document-supersession case.
		.leftJoin(
			documentFile,
			and(
				eq(documentFile.documentId, document.id),
				eq(documentFile.locale, locals.locale),
				eq(documentFile.isCurrent, true)
			)
		)
		.where(
			inArray(
				document.id,
				granted.map((row) => row.documentId)
			)
		)
		.orderBy(document.position);

	// The soonest expiry across live grants is what the viewer needs to see:
	// it is the date some of this list starts disappearing.
	const expiresAt = granted.reduce<Date | null>(
		(soonest, row) => (soonest === null || row.expiresAt < soonest ? row.expiresAt : soonest),
		null
	);

	return {
		expiresAt,
		outstanding,
		records: acceptanceRecords,
		documents: rows.map((row) => ({ ...row, title: row.title ?? row.slug }))
	};
};
