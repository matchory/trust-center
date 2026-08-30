import { error, redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { completeLogin } from '$lib/server/auth/oidc';
import { extractGroups, mapRole } from '$lib/server/auth/roles';
import {
	SESSION_COOKIE,
	STAFF_COOKIE_OPTIONS,
	createStaffSession,
	revokeAllStaffSessions,
	upsertStaffUser
} from '$lib/server/auth/session';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { localizePath } from '$lib/i18n/locale';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const { url, cookies, locals, request } = event;
	const db = getDb();
	const config = getConfig();

	const ip = clientIp(event) ?? undefined;
	const ua = request.headers.get('user-agent') ?? undefined;

	/**
	 * Every failed callback is an event a security review asks about, and until
	 * now they were the only auth outcomes going unrecorded. The actor is
	 * `staff-unresolved` because no staff_user row was reached; where an OIDC
	 * subject is even available it belongs in `meta`, never in an id column
	 * shared with real staff_user ids.
	 *
	 * `meta` never carries the authorization code, the client secret, or a raw
	 * error `cause` — `openid-client` attaches the whole callback request to its
	 * errors, which is the exact mistake `handleError` exists to prevent.
	 */
	async function recordFailure(reason: string, extra: Record<string, unknown> = {}) {
		await recordEvent(db, {
			action: 'staff.login_failed',
			actor: { type: 'staff-unresolved', id: null },
			ip,
			ua,
			meta: { reason, ...extra }
		});
	}

	// The IdP refused before we ever get a code — consent declined, an account
	// locked out, an unregistered client. Checked before the exchange, which
	// would otherwise fail with a far less specific error.
	const idpError = url.searchParams.get('error');
	if (idpError) {
		await recordFailure('idp_error', {
			error: idpError,
			errorDescription: url.searchParams.get('error_description')
		});
		error(400, 'The identity provider refused the login.');
	}

	const state = cookies.get('tc_oidc_state');
	const codeVerifier = cookies.get('tc_oidc_verifier');

	cookies.delete('tc_oidc_state', { path: '/auth' });
	cookies.delete('tc_oidc_verifier', { path: '/auth' });

	if (!state || !codeVerifier) {
		await recordFailure('state_mismatch');
		error(400, 'Login session expired. Please try again.');
	}

	let claims: Record<string, unknown>;
	try {
		claims = await completeLogin(url, { state, codeVerifier });
	} catch (cause) {
		// A replayed code, a state that does not match the cookie, a token
		// endpoint that rejected us. Recorded, then rethrown unchanged so
		// `handleError` still logs its message under a correlation id — the
		// error itself never reaches `meta`, because openid-client attaches the
		// callback request (authorization code and all) to it.
		await recordFailure('code_exchange_failed');
		throw cause;
	}

	const sub = typeof claims.sub === 'string' ? claims.sub : null;
	const email = typeof claims.email === 'string' ? claims.email : null;
	const name = typeof claims.name === 'string' ? claims.name : (email ?? 'Unknown');
	if (!sub || !email) {
		await recordFailure('missing_claims', {
			hasSub: sub !== null,
			hasEmail: email !== null
		});
		error(400, 'The identity provider did not return sub and email claims.');
	}

	const groups = extractGroups(claims, config.oidc.groupsClaim);
	const role = mapRole(groups, config.oidc.adminGroup, config.oidc.approverGroup);

	if (role === null) {
		// No staff_user row exists for a denied login (we never create one for
		// someone we just refused), so there is no staff_user id to use as the
		// actor/subject — the OIDC subject lives only in `meta`, never in an
		// identifier column shared with real staff_user ids.
		//
		// Naming the staff member's email, OIDC subject and groups here is
		// deliberate and permanent. Spec §10 confines *requester* personal data
		// to ip/ua/actor_id and places staff outside that restriction, because
		// an access review has to answer "which IdP identity was this, and what
		// did the IdP claim" long after the staff_user row is gone — which
		// actor_id alone cannot. The table is append-only, so these rows can
		// never be corrected or redacted; changing the policy means a migration
		// that stops *future* writes, never an UPDATE of what is already here.
		//
		// This is the `no_role` failure. It keeps its own action rather than
		// joining `staff.login_failed`, because it already carries strictly more
		// — the claims that produced the refusal — and one callback must not
		// write two events for one outcome.
		await recordEvent(db, {
			action: 'staff.login.denied',
			actor: { type: 'staff-unresolved', id: null },
			ip,
			ua,
			meta: { oidcSub: sub, email, groups }
		});
		error(403, 'Your account is not a member of a group authorised to use this trust center.');
	}

	const user = await upsertStaffUser(db, { oidcSub: sub, email, name, role });

	if (user.disabledAt !== null) {
		await recordEvent(db, {
			action: 'staff.login.denied',
			actor: { type: 'staff', id: user.id },
			subjectType: 'staff',
			subjectId: user.id,
			ip,
			ua,
			meta: { reason: 'disabled', role }
		});
		error(403, 'Your account has been disabled.');
	}

	// Before the new session is minted, or it would revoke itself.
	await revokeAllStaffSessions(db, user.id);

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

	cookies.set(SESSION_COOKIE, token, { ...STAFF_COOKIE_OPTIONS, expires: expiresAt });

	redirect(303, localizePath('/admin', locals.locale));
};
