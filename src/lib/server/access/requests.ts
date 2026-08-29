import { and, eq, inArray } from 'drizzle-orm';
import { accessRequest, accessRequestDocument, document, documentTranslation } from '../db/schema';
import { issueMagicLink } from '../identity/magic-link';
import type { Db } from '../db';

/** A submission the server will not accept. Never surfaced to the submitter. */
export class RequestRejected extends Error {}

export interface RequestableDocument {
	id: string;
	slug: string;
	title: string;
}

/**
 * The only documents a prospect may put in a scope: published and at the request
 * tier. NDA-tier is Phase 3, and a public document needs no request.
 */
export async function requestableDocuments(db: Db, locale: string): Promise<RequestableDocument[]> {
	const rows = await db
		.select({ id: document.id, slug: document.slug, title: documentTranslation.title })
		.from(document)
		.leftJoin(
			documentTranslation,
			and(eq(documentTranslation.documentId, document.id), eq(documentTranslation.locale, locale))
		)
		.where(and(eq(document.tier, 'request'), eq(document.status, 'published')))
		.orderBy(document.position);

	// A document with no translation in this locale still has to be selectable,
	// so the slug stands in — the same fallback the portal already uses.
	return rows.map((row) => ({ id: row.id, slug: row.slug, title: row.title ?? row.slug }));
}

export interface SubmitRequestInput {
	email: string;
	name: string;
	company: string;
	justification: string | null;
	documentIds: readonly string[];
	allRequestTier: boolean;
	/** Recorded on the requester at verification; every mail renders in it. */
	locale: string;
	/**
	 * Passed in rather than read from config, so this module needs no configured
	 * environment of its own — the route owns that lookup.
	 */
	linkTtlMinutes: number;
}

/**
 * Creates the unverified request, its scope, and its magic link in one
 * transaction, and returns the raw token for the caller to queue. Nothing
 * observable differs between a first-time and a repeat submission — spec §9.1
 * requires the response to be byte-identical whether or not the email is known.
 */
export async function submitRequest(
	db: Db,
	input: SubmitRequestInput
): Promise<{ requestId: string; magicLinkToken: string }> {
	if (!input.allRequestTier && input.documentIds.length === 0) {
		throw new RequestRejected('empty scope: name at least one document');
	}

	return db.transaction(async (tx) => {
		if (input.documentIds.length > 0) {
			// Inside the transaction, so a document unpublished between the check
			// and the insert cannot slip into a scope.
			const allowed = await tx
				.select({ id: document.id })
				.from(document)
				.where(
					and(
						inArray(document.id, [...input.documentIds]),
						eq(document.tier, 'request'),
						eq(document.status, 'published')
					)
				);

			if (allowed.length !== new Set(input.documentIds).size) {
				throw new RequestRejected('not requestable: one or more documents are out of scope');
			}
		}

		const [row] = await tx
			.insert(accessRequest)
			.values({
				status: 'unverified',
				allRequestTier: input.allRequestTier,
				justification: input.justification,
				source: 'portal',
				submittedEmail: input.email.trim().toLowerCase(),
				submittedName: input.name.trim(),
				submittedCompany: input.company.trim()
			})
			.returning({ id: accessRequest.id });

		if (!row) throw new Error('failed to create access request');

		if (input.documentIds.length > 0) {
			await tx.insert(accessRequestDocument).values(
				[...new Set(input.documentIds)].map((documentId) => ({
					requestId: row.id,
					documentId
				}))
			);
		}

		const { token } = await issueMagicLink(tx, {
			purpose: 'verify_request',
			requestId: row.id,
			ttlMinutes: input.linkTtlMinutes
		});

		return { requestId: row.id, magicLinkToken: token };
	});
}
