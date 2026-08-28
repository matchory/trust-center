import { z } from 'zod';

const schema = z.object({
	DATABASE_URL: z.string().min(1),
	PUBLIC_BASE_URL: z.string().url(),
	OIDC_ISSUER: z.string().url(),
	OIDC_CLIENT_ID: z.string().min(1),
	OIDC_CLIENT_SECRET: z.string().min(1),
	OIDC_ADMIN_GROUP: z.string().min(1),
	OIDC_APPROVER_GROUP: z.string().min(1).optional(),
	OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
	SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12)
});

export interface AppConfig {
	databaseUrl: string;
	publicBaseUrl: string;
	sessionTtlHours: number;
	oidc: {
		issuer: string;
		clientId: string;
		clientSecret: string;
		groupsClaim: string;
		adminGroup: string;
		approverGroup: string | undefined;
	};
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
	const result = schema.safeParse(env);

	if (!result.success) {
		const problems = result.error.issues
			.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
			.sort()
			.join('\n');
		throw new Error(`Invalid environment configuration:\n${problems}`);
	}

	const parsed = result.data;

	return {
		databaseUrl: parsed.DATABASE_URL,
		publicBaseUrl: parsed.PUBLIC_BASE_URL,
		sessionTtlHours: parsed.SESSION_TTL_HOURS,
		oidc: {
			issuer: parsed.OIDC_ISSUER,
			clientId: parsed.OIDC_CLIENT_ID,
			clientSecret: parsed.OIDC_CLIENT_SECRET,
			groupsClaim: parsed.OIDC_GROUPS_CLAIM,
			adminGroup: parsed.OIDC_ADMIN_GROUP,
			approverGroup: parsed.OIDC_APPROVER_GROUP
		}
	};
}
