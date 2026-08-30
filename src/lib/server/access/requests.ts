import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { groupByKey } from '../collections';
import {
	accessRequest,
	accessRequestDocument,
	accessRequestTier,
	document,
	documentTranslation,
	requester
} from '../db/schema';
import { issueMagicLink } from '../identity/magic-link';
import { createGrant } from './grants';
import { honouredTiers, PHASE_TIERS, requestTiers, setRequestTiers } from './scope';
import type { AccessRequestStatus, ScopeTier } from '../../access-types';
import type { Db } from '../db';

/** A submission the server will not accept. Never surfaced to the submitter. */
export class RequestRejected extends Error {}

export interface RequestableDocument {
	id: string;
	slug: string;
	title: string;
}

/**
 * The only documents a prospect may put in a scope: published, and at a tier
 * this phase honours. NDA-tier is Phase 3b, and a public document needs no
 * request.
 */
export async function requestableDocuments(db: Db, locale: string): Promise<RequestableDocument[]> {
	const rows = await db
		.select({ id: document.id, slug: document.slug, title: documentTranslation.title })
		.from(document)
		.leftJoin(
			documentTranslation,
			and(eq(documentTranslation.documentId, document.id), eq(documentTranslation.locale, locale))
		)
		.where(and(inArray(document.tier, [...PHASE_TIERS]), eq(document.status, 'published')))
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
	/** Blanket tiers: "everything at this tier". Beside the explicit documents,
	 *  never implying them. */
	tiers: readonly string[];
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
	const tiers = honouredTiers(input.tiers);

	// An empty scope is a submission that asks for nothing. A posted `nda` tier
	// reduces to nothing here, which is the same refusal Phase 2 gave a posted
	// NDA-tier document id.
	if (tiers.length === 0 && input.documentIds.length === 0) {
		throw new RequestRejected('empty scope: name at least one document or tier');
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
						inArray(document.tier, [...PHASE_TIERS]),
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
				justification: input.justification,
				source: 'portal',
				submittedEmail: input.email.trim().toLowerCase(),
				submittedName: input.name.trim(),
				submittedCompany: input.company.trim()
			})
			.returning({ id: accessRequest.id });

		if (!row) throw new Error('failed to create access request');

		await setRequestTiers(tx, row.id, tiers);

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

export type Decision = 'approve' | 'deny' | 'request_info';

/** A decision the server will not apply. Surfaced to staff, unlike RequestRejected. */
export class DecisionRejected extends Error {}

export interface DecideRequestInput {
	requestId: string;
	staffUserId: string;
	decision: Decision;
	documentIds: readonly string[];
	tiers: readonly string[];
	groupIds: readonly string[];
	/** The approver's chosen term. The route resolves the default. */
	termDays: number;
	reason: string | null;
}

/**
 * Spec §9.4. The scope written to the grant is the *staff-chosen* one, not the
 * requested one: an approver may narrow an approval, and silently granting
 * whatever was asked for would make that control decorative.
 *
 * One transaction, because the grant and the status change are one decision. A
 * grant without its status would be invisible to the queue; a status without
 * its grant would tell a requester they have access they do not have.
 */
export async function decideRequest(
	db: Db,
	input: DecideRequestInput
): Promise<{ status: AccessRequestStatus; grantId: string | null }> {
	return db.transaction(async (tx) => {
		const [request] = await tx
			.select()
			.from(accessRequest)
			.where(eq(accessRequest.id, input.requestId))
			.limit(1);

		if (!request) throw new DecisionRejected('no such request');
		if (!request.requesterId) throw new DecisionRejected('request is not verified');
		// Idempotence is not enough here: a second approval would mint a second
		// grant, so a decided request is closed to further decisions.
		if (request.status === 'approved' || request.status === 'denied') {
			throw new DecisionRejected('request is already decided');
		}

		if (input.decision === 'request_info') {
			// Deliberately leaves decidedAt and decidedByStaffId null: asking a
			// question is not a decision, and the request stays in the queue.
			await tx
				.update(accessRequest)
				.set({ status: 'info_requested', reason: input.reason })
				.where(eq(accessRequest.id, request.id));

			return { status: 'info_requested', grantId: null };
		}

		if (input.decision === 'deny') {
			await tx
				.update(accessRequest)
				.set({
					status: 'denied',
					reason: input.reason,
					decidedByStaffId: input.staffUserId,
					decidedAt: new Date()
				})
				.where(eq(accessRequest.id, request.id));

			return { status: 'denied', grantId: null };
		}

		const documentIds = [...new Set(input.documentIds)];
		const tiers = honouredTiers(input.tiers);
		// Deliberately NOT validated against the tiers of the documents inside
		// them. A group is the operator's own object and its membership is
		// already constrained by what they put in it; re-deriving that at
		// decision time is the recompute the design rejects.
		const groupIds = [...new Set(input.groupIds)];

		if (documentIds.length === 0 && tiers.length === 0 && groupIds.length === 0) {
			throw new DecisionRejected('empty scope: an approval must grant something');
		}

		if (documentIds.length > 0) {
			// Inside the transaction, and re-checked against the tier rather than
			// trusted from the form: a document at a tier this phase does not
			// honour cannot be approved in a phase that cannot gate it.
			const allowed = await tx
				.select({ id: document.id })
				.from(document)
				.where(
					and(
						inArray(document.id, documentIds),
						inArray(document.tier, [...PHASE_TIERS]),
						eq(document.status, 'published')
					)
				);

			if (allowed.length !== documentIds.length) {
				throw new DecisionRejected('not requestable: one or more documents are out of scope');
			}
		}

		const { grantId } = await createGrant(tx, {
			requesterId: request.requesterId,
			requestId: request.id,
			documentIds,
			tiers,
			groupIds,
			termDays: input.termDays,
			expiresAt: new Date(Date.now() + input.termDays * 24 * 60 * 60 * 1000)
		});

		await tx
			.update(accessRequest)
			.set({
				status: 'approved',
				decidedByStaffId: input.staffUserId,
				decidedAt: new Date(),
				reason: null
			})
			.where(eq(accessRequest.id, request.id));

		return { status: 'approved', grantId };
	});
}

export interface AdminRequestRow {
	id: string;
	status: AccessRequestStatus;
	email: string;
	name: string;
	company: string;
	companyDomain: string;
	tiers: ScopeTier[];
	documentCount: number;
	createdAt: Date;
	decidedAt: Date | null;
}

/**
 * The triage queue. `unverified` rows are deliberately absent: nobody has
 * proven they control that address, there is no decision staff can make about
 * one, and listing them would put unverified email in front of an operator for
 * nothing. The sweep job deletes them.
 */
export async function listRequestsForAdmin(db: Db): Promise<AdminRequestRow[]> {
	const rows = await db
		.select({
			id: accessRequest.id,
			status: accessRequest.status,
			createdAt: accessRequest.createdAt,
			decidedAt: accessRequest.decidedAt,
			email: requester.email,
			name: requester.name,
			company: requester.company,
			companyDomain: requester.companyDomain
		})
		.from(accessRequest)
		.innerJoin(requester, eq(accessRequest.requesterId, requester.id))
		.where(ne(accessRequest.status, 'unverified'))
		.orderBy(desc(accessRequest.createdAt));

	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);

	const [counts, tierRows] = await Promise.all([
		db
			.select({ requestId: accessRequestDocument.requestId, count: sql<number>`count(*)::int` })
			.from(accessRequestDocument)
			.where(inArray(accessRequestDocument.requestId, ids))
			.groupBy(accessRequestDocument.requestId),
		db
			.select({ requestId: accessRequestTier.requestId, tier: accessRequestTier.tier })
			.from(accessRequestTier)
			.where(inArray(accessRequestTier.requestId, ids))
			.orderBy(asc(accessRequestTier.tier))
	]);

	const countByRequest = new Map(counts.map((row) => [row.requestId, row.count]));
	const tiers = groupByKey(tierRows, (row) => row.requestId);

	return rows.map((row) => ({
		...row,
		status: row.status as AccessRequestStatus,
		tiers: (tiers.get(row.id) ?? []).map((tier) => tier.tier as ScopeTier),
		documentCount: countByRequest.get(row.id) ?? 0
	}));
}

export interface AdminRequestDetail extends AdminRequestRow {
	justification: string | null;
	reason: string | null;
	requesterId: string;
	requesterLocale: string;
	/**
	 * What the prospect asked for. The approver may narrow or widen it, so the
	 * decision form pre-checks from these and posts whatever staff chose.
	 * `tiers`, inherited from the row type, is the tier half of the same answer.
	 */
	requestedDocumentIds: string[];
}

export async function getRequestForAdmin(db: Db, id: string): Promise<AdminRequestDetail | null> {
	const [row] = await db
		.select({
			id: accessRequest.id,
			status: accessRequest.status,
			justification: accessRequest.justification,
			reason: accessRequest.reason,
			createdAt: accessRequest.createdAt,
			decidedAt: accessRequest.decidedAt,
			requesterId: requester.id,
			email: requester.email,
			name: requester.name,
			company: requester.company,
			companyDomain: requester.companyDomain,
			requesterLocale: requester.locale
		})
		.from(accessRequest)
		.innerJoin(requester, eq(accessRequest.requesterId, requester.id))
		.where(and(eq(accessRequest.id, id), ne(accessRequest.status, 'unverified')))
		.limit(1);

	if (!row) return null;

	const [scoped, tiers] = await Promise.all([
		db
			.select({ documentId: accessRequestDocument.documentId })
			.from(accessRequestDocument)
			.where(eq(accessRequestDocument.requestId, row.id)),
		requestTiers(db, row.id)
	]);

	return {
		...row,
		status: row.status as AccessRequestStatus,
		tiers,
		documentCount: scoped.length,
		requestedDocumentIds: scoped.map((entry) => entry.documentId)
	};
}
