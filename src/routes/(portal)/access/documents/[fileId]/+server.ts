import { serveDocumentFile } from '$lib/server/delivery/serve';
import type { RequestHandler } from './$types';

/**
 * Gated delivery. It lives under `/{locale}/access` rather than beside the
 * public endpoint because that is the path the requester cookie is scoped to —
 * see `serveDocumentFile`.
 *
 * The subtree's `+layout.server.ts` guard does not run for endpoints, so the
 * authorization here is the only authorization there is.
 *
 * Both gated tiers, named explicitly rather than "everything that is not
 * public": adding a tier must not widen access by omission. What separates them
 * is not the path but the grant — an `nda`-tier document is conferred only by a
 * grant whose agreements are satisfied, which `mayDownload` already asks.
 */
export const GET: RequestHandler = (event) => serveDocumentFile(event, ['request', 'nda']);
