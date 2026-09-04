import { eq } from 'drizzle-orm';
import {
	accessGrant,
	accessRequest,
	document,
	documentFile,
	documentTranslation,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	requester
} from '../db/schema';
import type { AuditEventRow } from '../audit';
import { localizePath, pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import type { EventModel } from './model';

/**
 * Everything an `EventModel` carries except `deliveryId`, which identifies the
 * delivery rather than the event. Keeping it out is what makes one enrichment
 * reusable across every endpoint the same audit row fans out to.
 */
export type EnrichedEvent = Omit<EventModel, 'deliveryId'>;

export type EnrichOutcome =
	| { kind: 'model'; model: EnrichedEvent }
	| { kind: 'skip'; reason: 'subject_purged' | 'subject_missing' };

export interface EnrichContext {
	baseUrl: string;
	/**
	 * `config.defaultLocale`, passed in by the job. Used only to build the
	 * admin link, which is locale-prefixed like every page URL in this
	 * application — the payload's audience is the operator's own staff, not the
	 * requester (spec §3.2).
	 */
	locale: string;
}

/** What an enricher returns; the shared fields are filled in around it. */
interface Enriched {
	data: Record<string, unknown>;
	summary: string;
	link: string | null;
	/**
	 * Overrides the enriched path's default of `true`. Set only by the
	 * anonymous branch of `document.downloaded`, where there is no verified
	 * identity to speak of (plan C5).
	 */
	verified?: boolean;
}

type Enricher = (
	db: Db,
	row: AuditEventRow,
	context: EnrichContext
) => Promise<Enriched | { skip: 'purged' | 'missing' }>;

interface PersonIdentity {
	name: string;
	email: string;
	company: string;
	companyDomain: string;
}

/**
 * Explicitly annotated rather than inferred: without it, TS widens the
 * `return person` inside each enricher's `if ('skip' in person)` guard back to
 * this function's full union instead of narrowing to the skip variants, and
 * every enricher below fails to typecheck against `Enricher`.
 */
type IdentityResult = { skip: 'missing' } | { skip: 'purged' } | { person: PersonIdentity };

/**
 * Personal data a consumer acts on. `purged_at` is the signal, NOT blank
 * columns: purgeRequester writes `purged-<id>@invalid` into `email`, so a
 * blank-column test would pass a purged row through with the one field a CRM
 * upserts on (spec §4.5, plan §Smaller corrections).
 */
function identity(row: typeof requester.$inferSelect | undefined): IdentityResult {
	if (!row) return { skip: 'missing' };
	if (row.purgedAt !== null) return { skip: 'purged' };

	return {
		person: {
			name: row.name,
			email: row.email,
			company: row.company,
			companyDomain: row.companyDomain
		}
	};
}

async function loadRequester(db: Db, id: string | null) {
	if (id === null) return undefined;
	const [row] = await db.select().from(requester).where(eq(requester.id, id)).limit(1);
	return row;
}

/**
 * The four access-request events share a loader: they differ only in which
 * decision columns are worth carrying, and one query is what a consumer
 * branching on `event` actually needs.
 */
const enrichAccessRequest: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	const [request] = await db
		.select()
		.from(accessRequest)
		.where(eq(accessRequest.id, row.subjectId))
		.limit(1);
	if (!request) return { skip: 'missing' };

	// Independent reads — both key off `request` alone — so they go together
	// rather than costing two sequential round trips per event.
	const [requester, [grant]] = await Promise.all([
		loadRequester(db, request.requesterId),
		db
			.select({
				id: accessGrant.id,
				termDays: accessGrant.termDays,
				expiresAt: accessGrant.expiresAt,
				acceptanceDueAt: accessGrant.acceptanceDueAt
			})
			.from(accessGrant)
			.where(eq(accessGrant.requestId, request.id))
			.limit(1)
	]);

	const person = identity(requester);
	if ('skip' in person) return person;

	return {
		data: {
			...person.person,
			requestId: request.id,
			status: request.status,
			justification: request.justification,
			...(row.meta as Record<string, unknown> | null),
			...(grant
				? {
						grantId: grant.id,
						termDays: grant.termDays,
						expiresAt: grant.expiresAt?.toISOString() ?? null,
						acceptanceDueAt: grant.acceptanceDueAt?.toISOString() ?? null
					}
				: {}),
			...(request.reason !== null ? { reason: request.reason } : {})
		},
		summary: summaryFor(row.action, person.person.company),
		// `localizePath` for the same reason the subscription digest uses it to
		// build its outbound absolute URLs: every page URL in this application is
		// locale-prefixed, and the prefix rule belongs in one place.
		link: `${context.baseUrl}${localizePath(`/admin/requests/${request.id}`, context.locale)}`
	};
};

const enrichGrantRevoked: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	const [grant] = await db
		.select()
		.from(accessGrant)
		.where(eq(accessGrant.id, row.subjectId))
		.limit(1);
	if (!grant) return { skip: 'missing' };

	const person = identity(await loadRequester(db, grant.requesterId));
	if ('skip' in person) return person;

	return {
		data: {
			...person.person,
			grantId: grant.id,
			termDays: grant.termDays,
			expiresAt: grant.expiresAt?.toISOString() ?? null,
			revokedAt: grant.revokedAt?.toISOString() ?? null
		},
		summary: `Access for ${person.person.company} was revoked`,
		link: `${context.baseUrl}${localizePath('/admin/grants', context.locale)}`
	};
};

/**
 * `nda_acceptance.recorded` and `nda_record.downloaded` share a subject.
 *
 * `nda_acceptance` itself carries `email`/`company`/`companyDomain` — see the
 * table's own comment and `purgeRequester`'s: they deliberately survive a
 * purge, under the Art. 17(3)(e) exemption, as legal evidence of who signed.
 * That exemption is about *retention*, not export. Reading those columns here
 * would quietly turn a kept evidence record into a live feed of a purged
 * person's name and address into an operator's n8n run history and CRM —
 * exactly what §4.5 exists to stop. So identity is sourced from `requester`
 * below, and a purge skips this event, the same way purgeRequester fails a
 * pending `outbound_email` rather than sending it. Do not "fix" this by
 * reading `ndaAcceptance.email` instead.
 */
const enrichNdaAcceptance =
	(verb: 'accepted' | 'downloaded'): Enricher =>
	async (db, row, context) => {
		if (row.subjectId === null) return { skip: 'missing' };

		const [acceptance] = await db
			.select({
				id: ndaAcceptance.id,
				requesterId: ndaAcceptance.requesterId,
				acceptedAt: ndaAcceptance.acceptedAt,
				slug: ndaTemplate.slug,
				version: ndaTemplateVersion.version
			})
			.from(ndaAcceptance)
			.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaAcceptance.versionId))
			.innerJoin(ndaTemplate, eq(ndaTemplate.id, ndaTemplateVersion.templateId))
			.where(eq(ndaAcceptance.id, row.subjectId))
			.limit(1);
		if (!acceptance) return { skip: 'missing' };

		// Identity comes from live `requester`, deliberately not from the
		// acceptance row's own denormalized columns — see the function comment.
		const person = identity(await loadRequester(db, acceptance.requesterId));
		if ('skip' in person) return person;

		return {
			data: {
				...person.person,
				acceptanceId: acceptance.id,
				template: acceptance.slug,
				version: acceptance.version,
				acceptedAt: acceptance.acceptedAt.toISOString()
			},
			summary:
				verb === 'accepted'
					? `${person.person.company} accepted ${acceptance.slug} v${acceptance.version}`
					: `${person.person.company} downloaded their ${acceptance.slug} record`,
			link: `${context.baseUrl}${localizePath(`/admin/requesters/${acceptance.requesterId}`, context.locale)}`
		};
	};

/**
 * The subject is a `document_file`, not a document (delivery/serve.ts), so the
 * title comes from file → document → translation. The actor id is null for
 * every public-tier download, which is a deliverable event and not a missing
 * subject (plan C5).
 */
const enrichDocumentDownloaded: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	// Both reads key off columns already on the audit row, so neither waits on
	// the other. `loadRequester` returns undefined for a null id without
	// querying, which is the public-tier case handled below.
	//
	// The translation join carries no locale predicate: pinning it to the
	// *file's* locale titled the payload in whatever language the download
	// happened to be in, which is the §3.2 failure verbatim — a German card in
	// an English-speaking team's channel because of which rendition a requester
	// clicked. So the join returns every translation and `pickTranslation`
	// chooses the operator's own. A document with no title in that locale still
	// falls back to the raw slug, whatever other locales it carries: the payload
	// is for the operator's staff, and a slug is how the content gap reaches
	// them as one.
	const [rows, requesterRow] = await Promise.all([
		db
			.select({
				id: documentFile.id,
				locale: documentFile.locale,
				version: documentFile.version,
				documentId: document.id,
				slug: document.slug,
				tier: document.tier,
				translationLocale: documentTranslation.locale,
				title: documentTranslation.title
			})
			.from(documentFile)
			.innerJoin(document, eq(document.id, documentFile.documentId))
			.leftJoin(documentTranslation, eq(documentTranslation.documentId, document.id))
			.where(eq(documentFile.id, row.subjectId)),
		loadRequester(db, row.actorId)
	]);
	const file = rows[0];
	if (!file) return { skip: 'missing' };

	// `context.locale` is the deployment's default locale (the job passes
	// nothing else), so it is both the requested and the fallback locale here —
	// named twice rather than through a second context field nothing would set
	// differently.
	const picked = pickTranslation(
		rows
			.filter((candidate) => candidate.translationLocale !== null)
			.map((candidate) => ({ locale: candidate.translationLocale!, value: candidate.title })),
		context.locale,
		context.locale
	);

	const document_ = {
		documentId: file.documentId,
		slug: file.slug,
		title: picked?.value ?? file.slug,
		tier: file.tier,
		locale: file.locale,
		version: file.version
	};

	// A public download has no requester at all — no session is created on that
	// path — so there is nobody to enrich and nobody to have been purged.
	if (row.actorId === null) {
		return {
			data: document_,
			summary: `${document_.title} was downloaded`,
			link: `${context.baseUrl}${localizePath(`/admin/documents/${file.documentId}`, context.locale)}`,
			// Nobody was identified, so nothing here is verified.
			verified: false
		};
	}

	const person = identity(requesterRow);
	if ('skip' in person) return person;

	return {
		data: { ...person.person, ...document_ },
		summary: `${person.person.company} downloaded ${document_.title}`,
		link: `${context.baseUrl}${localizePath(`/admin/documents/${file.documentId}`, context.locale)}`
	};
};

/**
 * Walked against `grep -rhoE "action: '[a-z0-9._-]+'" src/` plus the two
 * template-literal sites (`access/verify.ts` and
 * `admin/requests/[id]/+page.server.ts`, both `access_request.${status}`) —
 * not against memory. `access_request.submitted` is deliberately absent: its
 * data is unverified public-form input (spec §4.3).
 */
const ENRICHERS: Record<string, Enricher> = {
	'access_request.pending': enrichAccessRequest,
	'access_request.approved': enrichAccessRequest,
	'access_request.denied': enrichAccessRequest,
	'access_request.info_requested': enrichAccessRequest,
	'access_grant.revoked': enrichGrantRevoked,
	'nda_acceptance.recorded': enrichNdaAcceptance('accepted'),
	'nda_record.downloaded': enrichNdaAcceptance('downloaded'),
	'document.downloaded': enrichDocumentDownloaded
};

/** `access_request.pending` → "Access request pending". */
function summaryFor(action: string, company?: string): string {
	const words = action.replace(/[._]/g, ' ');
	const sentence = words.charAt(0).toUpperCase() + words.slice(1);
	return company ? `${sentence} — ${company}` : sentence;
}

export async function enrichEvent(
	db: Db,
	row: AuditEventRow,
	context: EnrichContext
): Promise<EnrichOutcome> {
	const shared = {
		action: row.action,
		at: row.at,
		eventId: row.id,
		// A bigint does not survive JSON.stringify, and `seq` is what makes a
		// gap detectable by a consumer (spec §4.4).
		seq: String(row.seq),
		subject:
			row.subjectType !== null && row.subjectId !== null
				? { type: row.subjectType, id: row.subjectId }
				: null,
		actor: { type: row.actorType, id: row.actorId }
	};

	const enricher = ENRICHERS[row.action];

	if (enricher) {
		const result = await enricher(db, row, context);
		if ('skip' in result) {
			return {
				kind: 'skip',
				reason: result.skip === 'purged' ? 'subject_purged' : 'subject_missing'
			};
		}

		// Every registered action is written after identity verification —
		// `access_request.pending` exists precisely because someone has by then
		// proven they control the address — so `true` is the default and an
		// enricher opts out of it explicitly.
		return {
			kind: 'model',
			model: { ...shared, ...result, verified: result.verified ?? true }
		};
	}

	// The fallback carries `meta` verbatim and neither `ip` nor `ua`. §6.6
	// already guarantees `meta` holds no requester personal data, so this is
	// safe by construction rather than by filtering — and a filter is a thing
	// somebody later forgets to extend (spec §4.2).
	return {
		kind: 'model',
		model: {
			...shared,
			verified: false,
			data: (row.meta as Record<string, unknown> | null) ?? {},
			summary: summaryFor(row.action),
			link: null
		}
	};
}
