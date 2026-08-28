import Provider from 'oidc-provider';

const ISSUER = process.env.ISSUER ?? 'http://localhost:5556';
// Comma-separated so the same client registration can serve both `pnpm dev`
// (port 5173) and the Playwright e2e preview server (port 4173).
const REDIRECT_URIS = (process.env.REDIRECT_URIS ?? 'http://localhost:5173/auth/callback').split(
	','
);

const USERS = {
	'admin@example.test': {
		sub: 'admin',
		email: 'admin@example.test',
		name: 'Ada Admin',
		groups: ['trust-center-admins']
	},
	'approver@example.test': {
		sub: 'approver',
		email: 'approver@example.test',
		name: 'Arno Approver',
		groups: ['trust-center-approvers']
	},
	'nobody@example.test': {
		sub: 'nobody',
		email: 'nobody@example.test',
		name: 'Nora Nobody',
		groups: []
	}
};

const BY_SUB = Object.fromEntries(Object.values(USERS).map((u) => [u.sub, u]));

const provider = new Provider(ISSUER, {
	clients: [
		{
			client_id: 'trust-center',
			client_secret: 'dev-secret',
			redirect_uris: REDIRECT_URIS,
			grant_types: ['authorization_code'],
			response_types: ['code']
		}
	],
	pkce: { required: () => true },
	scopes: ['openid', 'email', 'profile', 'groups'],
	claims: {
		openid: ['sub'],
		email: ['email'],
		profile: ['name'],
		groups: ['groups']
	},
	// With the default conformIdTokenClaims:true, the authorization-code flow
	// restricts the ID token to `sub` and serves email/groups from userinfo only.
	// completeLogin() reads claims straight off the ID token, so disable it.
	conformIdTokenClaims: false,
	features: {
		devInteractions: { enabled: true }
	},
	async findAccount(_ctx, id) {
		const user = BY_SUB[id];
		if (!user) return undefined;
		return {
			accountId: id,
			async claims() {
				return { sub: user.sub, email: user.email, name: user.name, groups: user.groups };
			}
		};
	}
});

// The built-in dev interaction screen accepts any password; the login name
// selects which fixture account is returned.
provider.listen(5556, () => {
	console.log(`dev-idp listening on ${ISSUER}`);
});
