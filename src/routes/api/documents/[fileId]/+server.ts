import { serveDocumentFile } from '$lib/server/delivery/serve';
import type { RequestHandler } from './$types';

/** Public delivery: streamed untouched, no session, still audited. */
export const GET: RequestHandler = (event) => serveDocumentFile(event, 'public');
