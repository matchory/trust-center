export type StaffRole = 'admin' | 'approver';

/**
 * Derives the staff role from IdP group membership. Returning null means the
 * user authenticated successfully but is not authorised to use the admin area.
 * Admin wins over approver when both groups are present.
 */
export function mapRole(
	groups: readonly string[],
	adminGroup: string,
	approverGroup: string | undefined
): StaffRole | null {
	if (groups.includes(adminGroup)) return 'admin';
	if (approverGroup !== undefined && groups.includes(approverGroup)) return 'approver';
	return null;
}

export function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
	const raw = claims[groupsClaim];

	if (typeof raw === 'string') return [raw];
	if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
	return [];
}
