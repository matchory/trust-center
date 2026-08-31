import { error, type RequestEvent } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { mayDownload } from '../access/grants';
import { recordEvent } from '../audit';
import { getDb } from '../db/instance';
import { document, documentFile } from '../db/schema';
import { getConfig } from '../config';
import { clientIp } from '../http/client-ip';
import { consumeRateLimit, rateLimitKey } from '../ratelimit';
import { getStorage, StorageObjectNotFound } from '../storage';
import { stampPdf } from './watermark';
import { m } from '../../paraglide/messages.js';
import { assertIsLocale } from '../../paraglide/runtime.js';
import type { DocumentTier } from '../../content-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single mediated path out of storage (spec §6.5). Everything a caller can
 * influence is a file id; the storage key never appears in a URL, a response
 * header, or the HTML.
 *
 * One implementation, two routes, because the two tiers must live at different
 * *paths* — not merely take different branches:
 *
 *   public   — `/api/documents/{fileId}`, streamed untouched, no session
 *   request  — `/{locale}/access/documents/{fileId}`, buffered and watermarked
 *              per recipient, requires a live grant
 *
 * The gated route sits inside `/{locale}/access` because that is the path the
 * requester cookie is scoped to. A gated download served from `/api/...` could
 * never be authorized: the browser would not send the cookie, so every request
 * would arrive anonymous. Widening the cookie to `Path=/` is the alternative,
 * and it would cost the portal its "public pages set no cookies" guarantee and
 * make every public response vary by cookie.
 *
 * `tiers` is the caller's declaration of which files this route serves, applied
 * as a membership test in the query — a file of any other tier is simply not
 * found, because adding a tier must not widen access by omission. `gated` is
 * the caller's declaration of the *policy*, stated rather than inferred from
 * that list: a mode derived from which tiers happen to be named is one a future
 * caller can change by accident.
 */
export async function serveDocumentFile(
	event: RequestEvent<{ fileId: string }>,
	route: { tiers: readonly DocumentTier[]; gated: boolean }
): Promise<Response> {
	const { tiers, gated } = route;
	const { params, request, locals } = event;

	// A malformed id must 404 like an unknown one rather than surfacing a
	// database type error — the two must be indistinguishable to a caller.
	if (!UUID.test(params.fileId)) error(404, 'Not found');

	const db = getDb();
	const ip = clientIp(event);

	// A missing client address falls back to a shared bucket rather than
	// skipping the check.
	const limited = await consumeRateLimit(db, {
		key: rateLimitKey('download:ip', ip ?? 'unknown'),
		limit: 120,
		windowSeconds: 3600
	});
	if (!limited.allowed) error(429, 'Too many requests');

	const [row] = await db
		.select({
			fileId: documentFile.id,
			documentId: documentFile.documentId,
			storageKey: documentFile.storageKey,
			filename: documentFile.filename,
			contentType: documentFile.contentType,
			sizeBytes: documentFile.sizeBytes,
			sha256: documentFile.sha256,
			locale: documentFile.locale,
			version: documentFile.version,
			tier: document.tier
		})
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(
			and(
				eq(documentFile.id, params.fileId),
				eq(document.status, 'published'),
				inArray(document.tier, [...tiers])
			)
		)
		.limit(1);

	if (!row) error(404, 'Not found');

	const requester = locals.requester;

	if (gated) {
		// A 404 rather than a 403: an unauthorized caller learns nothing about
		// whether this file id exists.
		if (!requester) error(404, 'Not found');
		if (!(await mayDownload(db, requester.id, row.documentId, { locales: getConfig().locales })))
			error(404, 'Not found');
	}

	let body: BodyInit;
	let contentLength: number;

	try {
		if (gated && requester) {
			// Buffered, because watermarking is not streamable. The bound is
			// MAX_UPLOAD_MB, the same ceiling that admitted the file. Document
			// uploads are PDF-only, so the stamper always applies.
			const stream = await getStorage().stream(row.storageKey);
			const source = new Uint8Array(await new Response(stream).arrayBuffer());

			const stamped = await stampPdf(source, getConfig().ndaFontDir, {
				name: requester.name,
				company: requester.company,
				email: requester.email,
				at: new Date(),
				notice: m.download_confidentiality_notice({}, { locale: assertIsLocale(locals.locale) })
			});

			// pdf-lib types its output as `Uint8Array<ArrayBufferLike>`, while
			// `BodyInit` admits only ArrayBuffer-backed views. pdf-lib never
			// allocates in a SharedArrayBuffer, so this narrows rather than
			// suppresses — and it avoids copying the whole file again.
			body = stamped as Uint8Array<ArrayBuffer>;
			// The *stamped* length. Sending the stored size would truncate every
			// watermarked download at the byte the original ended.
			contentLength = stamped.byteLength;
		} else {
			body = await getStorage().stream(row.storageKey);
			contentLength = row.sizeBytes;
		}
	} catch (cause) {
		// A row without its object is an operator problem, not a visitor one.
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	// Written before the body is returned so a download cannot complete
	// unrecorded. `meta` carries no personal data: spec §10 confines that to
	// ip, ua, and actor_id.
	await recordEvent(db, {
		action: 'document.downloaded',
		actor: { type: 'requester', id: requester?.id ?? null },
		subjectType: 'document_file',
		subjectId: row.fileId,
		ip: ip ?? undefined,
		ua: request.headers.get('user-agent') ?? undefined,
		meta: {
			documentId: row.documentId,
			locale: row.locale,
			version: row.version,
			sha256: row.sha256,
			tier: row.tier,
			watermarked: gated
		}
	});

	return new Response(body, {
		headers: {
			'content-type': row.contentType,
			'content-length': String(contentLength),
			// `filename*` in RFC 5987 form so non-ASCII titles survive.
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
			// Every download is an audited occurrence, so no cache may satisfy
			// one on our behalf. This costs bandwidth and buys the audit trail
			// the product exists to provide.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
}
