import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { document, documentFile } from '$lib/server/db/schema';
import { getStorage, StorageObjectNotFound } from '$lib/server/storage';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single mediated path out of storage (spec §6.5). Everything a caller can
 * influence is a file id; the storage key never appears in a URL, a response
 * header, or the HTML.
 *
 * Phase 2 inserts grant resolution and per-recipient watermarking between the
 * lookup and the stream. The tier check below is the Phase 1 stand-in and is
 * deliberately written as an allowlist of one, so adding a tier cannot widen
 * access by omission.
 */
export const GET: RequestHandler = async ({ params, getClientAddress, request }) => {
	// A malformed id must 404 like an unknown one rather than surfacing a
	// database type error — the two must be indistinguishable to a caller.
	if (!UUID.test(params.fileId)) error(404, 'Not found');

	const db = getDb();

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
			version: documentFile.version
		})
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(
			and(
				eq(documentFile.id, params.fileId),
				eq(document.tier, 'public'),
				eq(document.status, 'published')
			)
		)
		.limit(1);

	if (!row) error(404, 'Not found');

	let body: ReadableStream<Uint8Array>;
	try {
		body = await getStorage().stream(row.storageKey);
	} catch (cause) {
		// A row without its object is an operator problem, not a visitor one.
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	// Written before the stream is returned so a download cannot complete
	// unrecorded. `meta` carries no personal data: spec §10 confines that to
	// ip, ua, and actor_id.
	await recordEvent(db, {
		action: 'document.downloaded',
		actor: { type: 'requester', id: null },
		subjectType: 'document_file',
		subjectId: row.fileId,
		ip: getClientAddress(),
		ua: request.headers.get('user-agent') ?? undefined,
		meta: {
			documentId: row.documentId,
			locale: row.locale,
			version: row.version,
			sha256: row.sha256
		}
	});

	return new Response(body, {
		headers: {
			'content-type': row.contentType,
			'content-length': String(row.sizeBytes),
			// `filename*` in RFC 5987 form so non-ASCII titles survive.
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
			// Every download is an audited occurrence, so no cache may satisfy
			// one on our behalf. This costs bandwidth and buys the audit trail
			// the product exists to provide.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
