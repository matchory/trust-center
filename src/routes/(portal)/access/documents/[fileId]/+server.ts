import { serveDocumentFile } from '$lib/server/delivery/serve';
import type { RequestHandler } from './$types';

/**
 * Gated delivery. It lives under `/{locale}/access` rather than beside the
 * public endpoint because that is the path the requester cookie is scoped to —
 * see `serveDocumentFile`.
 *
 * The subtree's `+layout.server.ts` guard does not run for endpoints, so the
 * authorization here is the only authorization there is.
 */
export const GET: RequestHandler = (event) => serveDocumentFile(event, 'request');
