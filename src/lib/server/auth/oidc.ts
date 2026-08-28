import * as client from 'openid-client';
import { getConfig } from '../config';

let cached: client.Configuration | undefined;

export async function getOidcConfig(): Promise<client.Configuration> {
	if (!cached) {
		const config = getConfig();
		const issuerIsHttps = new URL(config.oidc.issuer).protocol === 'https:';

		cached = await client.discovery(
			new URL(config.oidc.issuer),
			config.oidc.clientId,
			config.oidc.clientSecret,
			undefined,
			// openid-client refuses HTTP discovery/token requests by default. Only
			// relax that for a non-HTTPS issuer (the dev-IdP on localhost) — a
			// production deployment configured with an HTTPS issuer keeps the
			// default, strict behaviour.
			issuerIsHttps ? undefined : { execute: [client.allowInsecureRequests] }
		);
	}
	return cached;
}

export function redirectUri(): string {
	return new URL('/auth/callback', getConfig().publicBaseUrl).toString();
}

export interface PendingLogin {
	url: string;
	state: string;
	codeVerifier: string;
}

export async function beginLogin(): Promise<PendingLogin> {
	const oidc = await getOidcConfig();
	const codeVerifier = client.randomPKCECodeVerifier();
	const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
	const state = client.randomState();

	const url = client.buildAuthorizationUrl(oidc, {
		redirect_uri: redirectUri(),
		scope: 'openid email profile groups',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state
	});

	return { url: url.toString(), state, codeVerifier };
}

/**
 * Access and refresh tokens are intentionally discarded here — only the ID
 * token claims are returned. The IdP is needed only at login; sessions are
 * ours from that point on.
 */
export async function completeLogin(
	currentUrl: URL,
	expected: { state: string; codeVerifier: string }
): Promise<Record<string, unknown>> {
	const oidc = await getOidcConfig();

	const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
		pkceCodeVerifier: expected.codeVerifier,
		expectedState: expected.state
	});

	const claims = tokens.claims();
	if (!claims) throw new Error('ID token contained no claims');

	return claims as unknown as Record<string, unknown>;
}
