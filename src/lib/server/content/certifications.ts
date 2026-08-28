import { and, asc, eq, inArray } from 'drizzle-orm';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import { certification, certificationTranslation, document, documentFile } from '../db/schema';

export interface PublicCertification {
	id: string;
	slug: string;
	framework: string;
	issuer: string;
	scope: string;
	scopeLocale: string;
	isScopeFallback: boolean;
	validFrom: Date | null;
	validUntil: Date | null;
	/** The current file of the linked certificate, if that document is public. */
	certificateFileId: string | null;
}

export async function listPublicCertifications(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicCertification[]> {
	const rows = await db
		.select()
		.from(certification)
		.where(eq(certification.published, true))
		.orderBy(asc(certification.position), asc(certification.slug));

	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);
	const documentIds = rows
		.map((row) => row.certificateDocumentId)
		.filter((id): id is string => id !== null);

	const [scopes, files] = await Promise.all([
		db
			.select()
			.from(certificationTranslation)
			.where(inArray(certificationTranslation.certificationId, ids)),
		documentIds.length === 0
			? Promise.resolve([])
			: db
					.select({
						documentId: documentFile.documentId,
						fileId: documentFile.id,
						locale: documentFile.locale
					})
					.from(documentFile)
					.innerJoin(document, eq(documentFile.documentId, document.id))
					.where(
						and(
							inArray(documentFile.documentId, documentIds),
							eq(documentFile.isCurrent, true),
							// The certificate link is only offered when the linked
							// document is itself publicly visible — otherwise the badge
							// would hand out a download the portal refuses to serve.
							eq(document.tier, 'public'),
							eq(document.status, 'published')
						)
					)
	]);

	const result: PublicCertification[] = [];

	for (const row of rows) {
		const scope = pickTranslation(
			scopes
				.filter((item) => item.certificationId === row.id)
				.map((item) => ({ locale: item.locale, value: item.scope })),
			opts.locale,
			opts.defaultLocale
		);
		if (!scope) continue;

		const file = row.certificateDocumentId
			? pickTranslation(
					files
						.filter((item) => item.documentId === row.certificateDocumentId)
						.map((item) => ({ locale: item.locale, value: item.fileId })),
					opts.locale,
					opts.defaultLocale
				)
			: null;

		result.push({
			id: row.id,
			slug: row.slug,
			framework: row.framework,
			issuer: row.issuer,
			scope: scope.value,
			scopeLocale: scope.locale,
			isScopeFallback: scope.isFallback,
			validFrom: row.validFrom,
			validUntil: row.validUntil,
			certificateFileId: file?.value ?? null
		});
	}

	return result;
}

export interface AdminCertification {
	id: string;
	slug: string;
	framework: string;
	issuer: string;
	validFrom: Date | null;
	validUntil: Date | null;
	certificateDocumentId: string | null;
	published: boolean;
	position: number;
	translations: { locale: string; scope: string }[];
}

export async function listCertificationsForAdmin(db: Db): Promise<AdminCertification[]> {
	const rows = await db
		.select()
		.from(certification)
		.orderBy(asc(certification.position), asc(certification.slug));
	if (rows.length === 0) return [];

	const scopes = await db
		.select()
		.from(certificationTranslation)
		.where(
			inArray(
				certificationTranslation.certificationId,
				rows.map((row) => row.id)
			)
		);

	return rows.map((row) => ({
		...row,
		translations: scopes
			.filter((scope) => scope.certificationId === row.id)
			.map((scope) => ({ locale: scope.locale, scope: scope.scope }))
	}));
}

export async function getCertificationForAdmin(
	db: Db,
	id: string
): Promise<AdminCertification | null> {
	return (await listCertificationsForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createCertification(
	db: Db,
	input: {
		slug: string;
		framework: string;
		issuer: string;
		validFrom: Date | null;
		validUntil: Date | null;
		certificateDocumentId: string | null;
		position?: number;
	}
): Promise<string> {
	const [row] = await db
		.insert(certification)
		.values({ ...input, position: input.position ?? 0 })
		.returning({ id: certification.id });

	if (!row) throw new Error('failed to insert certification');
	return row.id;
}

export async function updateCertification(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		framework: string;
		issuer: string;
		validFrom: Date | null;
		validUntil: Date | null;
		certificateDocumentId: string | null;
		published: boolean;
		position: number;
	}>
): Promise<void> {
	await db
		.update(certification)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(certification.id, id));
}

export async function deleteCertification(db: Db, id: string): Promise<void> {
	await db.delete(certification).where(eq(certification.id, id));
}

export async function setCertificationTranslation(
	db: Db,
	certificationId: string,
	locale: string,
	values: { scope: string }
): Promise<void> {
	await db
		.insert(certificationTranslation)
		.values({ certificationId, locale, ...values })
		.onConflictDoUpdate({
			target: [certificationTranslation.certificationId, certificationTranslation.locale],
			set: values
		});
}
