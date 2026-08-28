import * as client from 'openid-client';
import { config } from '../config';

let cached: client.Configuration | undefined;

export async function getOidcConfig(): Promise<client.Configuration> {
	if (!cached) {
		cached = await client.discovery(
			new URL(config.oidc.issuer),
			config.oidc.clientId,
			config.oidc.clientSecret
		);
	}
	return cached;
}

export function redirectUri(): string {
	return new URL('/auth/callback', config.publicBaseUrl).toString();
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
