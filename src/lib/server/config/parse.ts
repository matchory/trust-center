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

/**
 * `k=v,k=v`, split on the *first* `=` only — an OTLP bearer token is a header
 * value that can itself contain `=`, and splitting on every one would truncate
 * it into a credential that fails authentication with no error here.
 */
function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};

	return Object.fromEntries(
		raw
			.split(',')
			.map((pair) => pair.trim())
			.filter((pair) => pair.length > 0)
			.map((pair) => {
				const split = pair.indexOf('=');
				return [pair.slice(0, split).trim(), pair.slice(split + 1).trim()];
			})
	);
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
	maxPdfPages: number;
	mailRetentionDays: number;
	sessionTtlHours: number;
	requesterSessionTtlHours: number;
	magicLinkTtlMinutes: number;
	accessGrantDefaultDays: number;
	accessGrantReminderDays: number;
	ndaAcceptanceDueDays: number;
	/** Directory holding the four faces the record PDF and the watermark embed. */
	ndaFontDir: string;
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
	/** Off unless `endpoint` is set; see docs/superpowers/specs/2026-09-02-otel-egress-design.md. */
	telemetry: {
		endpoint: string | undefined;
		serviceName: string;
		headers: Record<string, string>;
		sampleRatio: number;
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
			MAX_PDF_PAGES: z.coerce.number().int().positive().default(1000),
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
			ACCESS_GRANT_REMINDER_DAYS: z.coerce.number().int().positive().default(7),
			NDA_ACCEPTANCE_DUE_DAYS: z.coerce.number().int().positive().default(14),
			NDA_FONT_DIR: z.string().min(1).default('./assets/fonts'),
			// Optional so `pnpm build` and the unit suite keep working with no mail
			// server. getMailer() throws a named error when a send is attempted
			// without it, rather than the application refusing to start.
			SMTP_URL: blankAsUndefined(z.string().url()),
			MAIL_FROM: z.string().min(1).default('trust-center@localhost'),
			MAIL_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
			STAFF_NOTIFICATION_EMAIL: blankAsUndefined(z.string().email()),
			// Standard OTel variable names, read and validated here rather than by
			// the SDK's own environment parsing: a typo'd endpoint must refuse to
			// boot like every other setting, not degrade to silently exporting
			// nothing. Only these four are honoured (spec C3).
			OTEL_EXPORTER_OTLP_ENDPOINT: blankAsUndefined(
				z
					.string()
					.url()
					// Zod's .url() alone accepts non-HTTP schemes like collector: (a valid
					// URL per RFC 3986), so this refine ensures only HTTP or HTTPS endpoints
					// reach the application.
					.refine(
						(url) => url.startsWith('http://') || url.startsWith('https://'),
						'must be an HTTP or HTTPS URL'
					)
			),
			OTEL_SERVICE_NAME: z.string().min(1).default('trust-center'),
			OTEL_EXPORTER_OTLP_HEADERS: blankAsUndefined(
				z
					.string()
					.min(1)
					.refine(
						(raw) => raw.split(',').every((pair) => pair.includes('=')),
						'expected comma-separated key=value pairs'
					)
			),
			OTEL_TRACES_SAMPLER_ARG: blankAsUndefined(z.coerce.number().min(0).max(1)).default(1)
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
		maxPdfPages: parsed.MAX_PDF_PAGES,
		mailRetentionDays: parsed.MAIL_RETENTION_DAYS,
		sessionTtlHours: parsed.SESSION_TTL_HOURS,
		requesterSessionTtlHours: parsed.REQUESTER_SESSION_TTL_HOURS,
		magicLinkTtlMinutes: parsed.MAGIC_LINK_TTL_MINUTES,
		accessGrantDefaultDays: parsed.ACCESS_GRANT_DEFAULT_DAYS,
		accessGrantReminderDays: parsed.ACCESS_GRANT_REMINDER_DAYS,
		ndaAcceptanceDueDays: parsed.NDA_ACCEPTANCE_DUE_DAYS,
		ndaFontDir: parsed.NDA_FONT_DIR,
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
		},
		telemetry: {
			endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
			serviceName: parsed.OTEL_SERVICE_NAME,
			headers: parseOtlpHeaders(parsed.OTEL_EXPORTER_OTLP_HEADERS),
			sampleRatio: parsed.OTEL_TRACES_SAMPLER_ARG
		}
	};
}
