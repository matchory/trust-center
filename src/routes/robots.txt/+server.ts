import { getConfig } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ setHeaders }) => {
	const { baseUrl } = getConfig();

	// The portal is meant to be found — that is the point of a trust center —
	// so crawling is allowed everywhere except the staff area and the endpoints
	// that only exist to be called by the app.
	const body = [
		'User-agent: *',
		'Disallow: /admin',
		'Disallow: /api',
		'Disallow: /auth',
		'',
		`Sitemap: ${baseUrl}/sitemap.xml`,
		''
	].join('\n');

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=3600, must-revalidate' });
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
