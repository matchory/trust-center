import { z } from 'zod';

/**
 * A `.env` conventionally spells "unset" as `KEY=`, which reaches us as an empty
 * string rather than as undefined — and `.optional()` accepts only the latter.
 * Without this, copying .env.example verbatim produces a deployment that
 * refuses to boot on a variable the operator deliberately left blank.
 */
function blankAsUndefined<T extends z.ZodTypeAny>(schema: T) {
	return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const localeList = z
	.string()
	.min(1)
	.transform((value) =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
	);

export interface AppConfig {
	databaseUrl: string;
	baseUrl: string;
	/** The locales this deployment serves. Always a subset of the compiled catalogs. */
	locales: readonly string[];
	defaultLocale: string;
	storageDir: string;
	maxUploadBytes: number;
	sessionTtlHours: number;
	requesterSessionTtlHours: number;
	magicLinkTtlMinutes: number;
	accessGrantDefaultDays: number;
	mail: {
		smtpUrl: string | undefined;
		from: string;
		staffNotificationEmail: string | undefined;
	};
	oidc: {
		issuer: string;
		clientId: string;
		clientSecret: string;
		groupsClaim: string;
		adminGroup: string;
		approverGroup: string | undefined;
	};
}

/**
 * `compiledLocales` is a parameter rather than an import so this module stays
 * free of `$lib` aliases and Paraglide's generated runtime, and therefore
 * testable under plain Vitest. `src/lib/server/config/index.ts` supplies the
 * real value.
 */
function buildSchema(compiledLocales: readonly string[]) {
	return z
		.object({
			DATABASE_URL: z.string().min(1),
			BASE_URL: z.string().url(),
			LOCALES: localeList,
			DEFAULT_LOCALE: z.string().min(1),
			STORAGE_DIR: z.string().min(1).default('./data/storage'),
			MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
			OIDC_ISSUER: z.string().url(),
			OIDC_CLIENT_ID: z.string().min(1),
			OIDC_CLIENT_SECRET: z.string().min(1),
			OIDC_ADMIN_GROUP: z.string().min(1),
			OIDC_APPROVER_GROUP: blankAsUndefined(z.string().min(1)),
			OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
			SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
			REQUESTER_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),
			MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(30),
			ACCESS_GRANT_DEFAULT_DAYS: z.coerce.number().int().positive().default(90),
			// Optional so `pnpm build` and the unit suite keep working with no mail
			// server. getMailer() throws a named error when a send is attempted
			// without it, rather than the application refusing to start.
			SMTP_URL: blankAsUndefined(z.string().url()),
			MAIL_FROM: z.string().min(1).default('trust-center@localhost'),
			STAFF_NOTIFICATION_EMAIL: blankAsUndefined(z.string().email())
		})
		.superRefine((value, ctx) => {
			const unsupported = value.LOCALES.filter((locale) => !compiledLocales.includes(locale));

			if (unsupported.length > 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['LOCALES'],
					message:
						`no message catalog is compiled for ${unsupported.join(', ')}. ` +
						`This image was built with: ${compiledLocales.join(', ')}. ` +
						`Enabling a new locale is a rebuild: add messages/<locale>.json, list it in ` +
						`project.inlang/settings.json, and build the image again.`
				});
			}

			if (!value.LOCALES.includes(value.DEFAULT_LOCALE)) {
				ctx.addIssue({
					code: 'custom',
					path: ['DEFAULT_LOCALE'],
					message: `"${value.DEFAULT_LOCALE}" is not one of LOCALES (${value.LOCALES.join(', ')})`
				});
			}
		});
}

export function parseConfig(
	env: Record<string, string | undefined>,
	compiledLocales: readonly string[]
): AppConfig {
	const result = buildSchema(compiledLocales).safeParse(env);

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
		// Normalised once here: every consumer concatenates a path onto it
		// (canonical URLs, the sitemap, robots.txt, the OIDC redirect URI),
		// and a trailing slash in the environment would double every one.
		baseUrl: parsed.BASE_URL.replace(/\/+$/, ''),
		locales: parsed.LOCALES,
		defaultLocale: parsed.DEFAULT_LOCALE,
		storageDir: parsed.STORAGE_DIR,
		maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
		sessionTtlHours: parsed.SESSION_TTL_HOURS,
		requesterSessionTtlHours: parsed.REQUESTER_SESSION_TTL_HOURS,
		magicLinkTtlMinutes: parsed.MAGIC_LINK_TTL_MINUTES,
		accessGrantDefaultDays: parsed.ACCESS_GRANT_DEFAULT_DAYS,
		mail: {
			smtpUrl: parsed.SMTP_URL,
			from: parsed.MAIL_FROM,
			staffNotificationEmail: parsed.STAFF_NOTIFICATION_EMAIL
		},
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
