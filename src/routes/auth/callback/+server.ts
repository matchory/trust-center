import { error, redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { completeLogin } from '$lib/server/auth/oidc';
import { extractGroups, mapRole } from '$lib/server/auth/roles';
import { SESSION_COOKIE, createStaffSession, upsertStaffUser } from '$lib/server/auth/session';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, getClientAddress, request }) => {
	const state = cookies.get('tc_oidc_state');
	const codeVerifier = cookies.get('tc_oidc_verifier');

	cookies.delete('tc_oidc_state', { path: '/auth' });
	cookies.delete('tc_oidc_verifier', { path: '/auth' });

	if (!state || !codeVerifier) error(400, 'Login session expired. Please try again.');

	const claims = await completeLogin(url, { state, codeVerifier });

	const sub = typeof claims.sub === 'string' ? claims.sub : null;
	const email = typeof claims.email === 'string' ? claims.email : null;
	const name = typeof claims.name === 'string' ? claims.name : (email ?? 'Unknown');
	if (!sub || !email) error(400, 'The identity provider did not return sub and email claims.');

	const groups = extractGroups(claims, config.oidc.groupsClaim);
	const role = mapRole(groups, config.oidc.adminGroup, config.oidc.approverGroup);

	const ip = getClientAddress();
	const ua = request.headers.get('user-agent') ?? undefined;

	if (role === null) {
		// No staff_user row exists for a denied login (we never create one for
		// someone we just refused), so actorId here is the raw OIDC `sub`
		// rather than a staff_user UUID as it is on the success path below.
		await recordEvent(db, {
			action: 'staff.login.denied',
			actor: { type: 'staff', id: sub },
			subjectType: 'staff',
			subjectId: sub,
			ip,
			ua,
			meta: { email, groups }
		});
		error(403, 'Your account is not a member of a group authorised to use this trust center.');
	}

	const user = await upsertStaffUser(db, { oidcSub: sub, email, name, role });
	const { token, expiresAt } = await createStaffSession(db, {
		staffUserId: user.id,
		ttlHours: config.sessionTtlHours,
		ip,
		ua
	});

	await recordEvent(db, {
		action: 'staff.login.succeeded',
		actor: { type: 'staff', id: user.id },
		subjectType: 'staff',
		subjectId: user.id,
		ip,
		ua,
		meta: { role }
	});

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: config.publicBaseUrl.startsWith('https://'),
		expires: expiresAt
	});

	redirect(303, '/admin');
};
