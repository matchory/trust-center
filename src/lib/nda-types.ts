/**
 * Whether an NDA acceptance is valid for the person who clicked, or for
 * everyone at their company domain. Here rather than in
 * `server/nda/settings.ts` because the settings form renders one radio per
 * scope, and a component may not import a server module — the same reason
 * `access-types.ts` holds `SCOPE_TIERS` instead of `server/access/scope.ts`.
 */
export const ACCEPTANCE_SCOPES = ['person', 'domain'] as const;
export type AcceptanceScope = (typeof ACCEPTANCE_SCOPES)[number];

/**
 * A grant's five states. Here rather than in `server/access/grants.ts` because
 * admin components render a badge per state and a component may not import a
 * server module — the same reason `SCOPE_TIERS` lives in `access-types.ts`
 * instead of `server/access/scope.ts`.
 */
export const GRANT_STATES = [
	'active',
	'expired',
	'revoked',
	'pending_acceptance',
	'unaccepted'
] as const;
export type GrantState = (typeof GRANT_STATES)[number];
