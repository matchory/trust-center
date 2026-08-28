import * as client from 'openid-client';
import { getConfig } from '../config';

let cached: client.Configuration | undefined;

// `new URL('http://[::1]:5556').hostname` is `[::1]` (brackets included) in
// Node's WHATWG URL implementation — compare against both the bracketed and
// bare forms or the loopback check below fails open on IPv6 loopback.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export async function getOidcConfig(): Promise<client.Configuration> {
	if (!cached) {
		const config = getConfig();
		const issuerUrl = new URL(config.oidc.issuer);
		const isInsecureLoopback =
			issuerUrl.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(issuerUrl.hostname);

		cached = await client.discovery(
			issuerUrl,
			config.oidc.clientId,
			config.oidc.clientSecret,
			undefined,
			// `allowInsecureRequests` isn't a per-request opt: it sets `tlsOnly =
			// false` permanently on the returned `Configuration`, which we cache
			// and reuse, so this relaxes every subsequent request against this
			// issuer for the process lifetime — discovery, token exchange
			// (including the client secret), JWKS, userinfo, refresh, revocation,
			// and introspection — and disables the callback URL's protocol check
			// too. Only ever relax this for a loopback issuer (the dev-IdP); a
			// remote `http://` issuer (e.g. an internal host behind a
			// TLS-terminating proxy, an easy misconfiguration for a self-hoster)
			// must keep openid-client's default strict, HTTPS-only behaviour.
			isInsecureLoopback ? { execute: [client.allowInsecureRequests] } : undefined
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
