import { error } from '@sveltejs/kit';
import { getBranding } from '$lib/server/content/branding';
import { getDb } from '$lib/server/db/instance';
import { getStorage, StorageObjectNotFound } from '$lib/server/storage';
import type { RequestHandler } from './$types';

/**
 * The logo goes through the storage port like every other stored object, so no
 * publicly reachable URL to storage exists (spec §6.5). Unlike the document
 * endpoint it writes no audit event — a logo is a page asset, not a document
 * access — and it may be cached, because there is nothing to record.
 */
export const GET: RequestHandler = async ({ setHeaders }) => {
	const branding = await getBranding(getDb());

	// A record with a key but no content type is incomplete, not a reason to
	// guess: sniffing an operator-supplied file is how an SVG becomes a script.
	if (!branding.logoStorageKey || !branding.logoContentType) error(404, 'Not found');

	let body: ReadableStream<Uint8Array>;
	try {
		body = await getStorage().stream(branding.logoStorageKey);
	} catch (cause) {
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return new Response(body, {
		headers: {
			'content-type': branding.logoContentType,
			'x-content-type-options': 'nosniff'
		}
	});
};
