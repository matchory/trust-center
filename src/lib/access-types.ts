export const ACCESS_RULE_ACTIONS = ['auto_approve', 'review', 'deny'] as const;
export type AccessRuleAction = (typeof ACCESS_RULE_ACTIONS)[number];

/**
 * `unverified` is the pre-verification state: the row holds a submission whose
 * email nobody has proven they control. `info_requested` is spec §9.4's third
 * triage outcome. There is deliberately no `pending_acceptance` — that is
 * Phase 3's NDA state, and this phase gates only the request tier.
 */
export const ACCESS_REQUEST_STATUSES = [
	'unverified',
	'pending',
	'info_requested',
	'approved',
	'denied'
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const ACCESS_REQUEST_SOURCES = ['portal', 'invite'] as const;
export type AccessRequestSource = (typeof ACCESS_REQUEST_SOURCES)[number];
