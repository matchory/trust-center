import { error } from '@sveltejs/kit';
import { and, eq, isNotNull } from 'drizzle-orm';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { ndaAcceptance, ndaTemplate, ndaTemplateVersion } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { getStorage, StorageObjectNotFound } from '$lib/server/storage';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A requester's own acceptance record (§10.3), on the same terms as a gated
 * document: the storage key never appears in a URL, the read is audited, and an
 * acceptance belonging to somebody else is not found rather than forbidden.
 *
 * It sits under `/{locale}/access` for the reason `serveDocumentFile` gives —
 * that is the path the requester cookie is scoped to. The subtree's layout
 * guard does not run for endpoints, so the ownership check here is the only one
 * there is.
 */
export const GET: RequestHandler = async (event) => {
	const { params, request, locals } = event;

	if (!UUID.test(params.acceptanceId)) error(404, 'Not found');

	const db = getDb();
	const ip = clientIp(event);

	const limited = await consumeRateLimit(db, {
		key: rateLimitKey('download:ip', ip ?? 'unknown'),
		limit: 120,
		windowSeconds: 3600
	});
	if (!limited.allowed) error(429, 'Too many requests');

	const requester = locals.requester;
	if (!requester) error(404, 'Not found');

	const [row] = await db
		.select({
			id: ndaAcceptance.id,
			storageKey: ndaAcceptance.recordPdfKey,
			slug: ndaTemplate.slug,
			version: ndaTemplateVersion.version
		})
		.from(ndaAcceptance)
		.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaAcceptance.versionId))
		.innerJoin(ndaTemplate, eq(ndaTemplate.id, ndaTemplateVersion.templateId))
		.where(
			and(
				eq(ndaAcceptance.id, params.acceptanceId),
				// Ownership is part of the lookup, not a check after it: a record is
				// the signatory's own and nobody else's.
				eq(ndaAcceptance.requesterId, requester.id),
				isNotNull(ndaAcceptance.recordPdfKey)
			)
		)
		.limit(1);

	if (!row?.storageKey) error(404, 'Not found');

	const storage = getStorage();
	let body: ReadableStream<Uint8Array>;
	let size: number;

	try {
		const stat = await storage.stat(row.storageKey);
		if (!stat) error(404, 'Not found');
		size = stat.size;
		body = await storage.stream(row.storageKey);
	} catch (cause) {
		// A row without its object is an operator problem, not a visitor one.
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	await recordEvent(db, {
		action: 'nda_record.downloaded',
		actor: { type: 'requester', id: requester.id },
		subjectType: 'nda_acceptance',
		subjectId: row.id,
		ip: ip ?? undefined,
		ua: request.headers.get('user-agent') ?? undefined,
		meta: { slug: row.slug, version: row.version }
	});

	const filename = `${row.slug}-v${row.version}-acceptance.pdf`;

	return new Response(body, {
		headers: {
			'content-type': 'application/pdf',
			'content-length': String(size),
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
