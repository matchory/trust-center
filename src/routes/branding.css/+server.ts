import { brandingCss, getBranding } from '$lib/server/content/branding';
import { getDb } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
	const css = brandingCss(await getBranding(getDb()));

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=300, must-revalidate' });
	return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
};
