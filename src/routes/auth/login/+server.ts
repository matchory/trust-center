import { redirect } from '@sveltejs/kit';
import { beginLogin } from '$lib/server/auth/oidc';
import { config } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies }) => {
	const { url, state, codeVerifier } = await beginLogin();

	const options = {
		path: '/auth',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: config.publicBaseUrl.startsWith('https://'),
		maxAge: 600
	};

	cookies.set('tc_oidc_state', state, options);
	cookies.set('tc_oidc_verifier', codeVerifier, options);

	redirect(303, url);
};
