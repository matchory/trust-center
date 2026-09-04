import { z } from 'zod';
import { EgressDestinationRejected, parseAllowList } from '../egress/destination';
import type { AllowEntry } from '../egress/destination';
import { SYSLOG_FACILITIES } from '../auditsink/syslog-message';

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
 * A PEM block is multi-line and a `docker run -e` argument is not, so an
 * operator's only way to pass one is `\n` escapes. A value that already
 * contains real newlines passes through untouched (decision D9).
 */
const pemText = (schema: z.ZodString) => schema.transform((value) => value.replace(/\\n/g, '\n'));

/** `URL.parse` is a Node 22.1+ static; this refinement runs at boot, so it
 * must not depend on a recent minor the Dockerfile's pinned `node:22` may
 * predate. */
function isValidUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * `tls://` and `tls:///path` are both syntactically valid URLs with an empty
 * `hostname`, and `net.connect` treats a falsy host as `localhost` — so a
 * missing host would boot a "configured" sink that quietly talks to itself
 * rather than refusing to boot like every other malformed setting here.
 * Returns true (no issue) for a value that already fails `isValidUrl`, so the
 * two refinements don't both fire over the same malformed string.
 */
function hasHost(value: string): boolean {
	try {
		return new URL(value).hostname !== '';
	} catch {
		return true;
	}
}

/**
 * `parseAllowList` reports a malformed entry by throwing, which is right for
 * its own callers but would escape zod as an unhandled error rather than
 * becoming the named boot-time refusal every other setting gets. Turned into
 * an issue here so `EVENT_EGRESS_ALLOW=10.1.0.0/40` fails the same way
 * `BASE_URL=nonsense` does.
 */
function parseAllowListOrIssue(raw: string, ctx: z.RefinementCtx): AllowEntry[] | typeof z.NEVER {
	try {
		return parseAllowList(raw);
	} catch (cause) {
		if (!(cause instanceof EgressDestinationRejected)) throw cause;
		ctx.addIssue({ code: 'custom', message: cause.message });
		return z.NEVER;
	}
}

/**
 * The schema's first boolean. `z.enum` rather than a truthiness check, so
 * `EVENT_EGRESS_ENABLED=1` refuses to boot instead of silently reading as
 * off — the same discipline the OTEL variables get, and this is the switch
 * that answers "does this deployment call out at all".
 *
 * RUN_JOBS and RUN_MIGRATIONS deliberately stay outside this schema: they are
 * read in hooks.server.ts's `init` to decide whether to *start* the subsystems
 * that own config, so they are consulted before this parse runs.
 */
const booleanFlag = z.preprocess(
	(value) => (value === '' || value === undefined ? 'false' : value),
	z.enum(['true', 'false']).transform((value) => value === 'true')
);

/**
 * `k=v,k=v`, split on the *first* `=` only — an OTLP bearer token is a header
 * value that can itself contain `=`, and splitting on every one would truncate
 * it into a credential that fails authentication with no error here.
 *
 * Parsing and validation are one chain in the schema below rather than a parse
 * here and a separate refine there: as two readings of the same string they
 * disagreed at the edges — the refine rejected a trailing comma this skips, and
 * neither rejected an empty key, so `=v` produced a `{'': 'v'}` header the
 * exporter cannot send. This is where the collector credential lives, so the
 * disagreement is made unrepresentable rather than kept in step by hand.
 */
function otlpHeaderEntries(raw: string): [string, string][] {
	return raw
		.split(',')
		.map((pair) => pair.trim())
		.filter((pair) => pair.length > 0)
		.map((pair): [string, string] => {
			const split = pair.indexOf('=');
			// No `=` at all leaves the key empty, which is exactly the state the
			// refine rejects — so a malformed entry fails validation rather than
			// being silently reshaped into a header.
			if (split < 0) return ['', ''];

			return [pair.slice(0, split).trim(), pair.slice(split + 1).trim()];
		});
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
	egress: {
		enabled: boolean;
		signingKey: string | undefined;
		/** `EVENT_EGRESS_ALLOW`, parsed. Empty means no allowance was configured. */
		allow: readonly AllowEntry[];
	};
	/** Subsystem B: ships the audit log off-box in batches. Off by default (spec §11). */
	auditSink: {
		enabled: boolean;
		batchRows: number;
		maxAgeMs: number;
		maxBytes: number;
		attestIntervalMs: number;
		s3:
			| {
					bucket: string;
					region: string;
					endpoint: string | undefined;
					accessKeyId: string;
					secretAccessKey: string;
					prefix: string | undefined;
			  }
			| undefined;
		syslog:
			| {
					url: string;
					tls: boolean;
					host: string;
					port: number;
					ca: string | undefined;
					clientCert: string | undefined;
					clientKey: string | undefined;
					facility: string;
					maxMessageBytes: number;
			  }
			| undefined;
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
					// Normalised here for the same reason BASE_URL is below: the
					// exporters concatenate `/v1/traces` and `/v1/metrics` onto this,
					// so `https://otel.internal:4318/` — the commonest form of this
					// typo, and one the standard SDK tolerates — would export to a
					// double slash and take a 404 from most collectors, silently.
					.transform((url) => url.replace(/\/+$/, ''))
			),
			OTEL_SERVICE_NAME: z.string().min(1).default('trust-center'),
			OTEL_EXPORTER_OTLP_HEADERS: blankAsUndefined(
				z
					.string()
					.min(1)
					.transform(otlpHeaderEntries)
					// At least one, and every key non-empty: a value that parses to
					// nothing (`,`) or to a nameless header (`=v`) is a typo in the one
					// setting that carries the collector credential, and it must refuse
					// to boot rather than authenticate with no header.
					.refine(
						(entries) => entries.length > 0 && entries.every(([key]) => key.length > 0),
						'expected comma-separated key=value pairs'
					)
					.transform((entries) => Object.fromEntries(entries))
			),
			OTEL_TRACES_SAMPLER_ARG: blankAsUndefined(z.coerce.number().min(0).max(1)).default(1),
			// Deploy-time switch. Endpoints live in the database so they can be
			// reconfigured by someone without shell access, and this is what keeps
			// "does this deployment call out, and to where?" answerable from
			// `docker inspect`: the environment answers whether, the database
			// answers where (spec §1.1). Also the kill switch that is not
			// RUN_JOBS=false, which would also stop mail.
			EVENT_EGRESS_ENABLED: booleanFlag,
			// Not blankAsUndefined + min(1): a signing key shorter than 32
			// characters is a weak HMAC key, and the failure is silent.
			EVENT_SIGNING_KEY: blankAsUndefined(z.string().min(32)),
			// Parsed here rather than carried through as a raw string, so a
			// malformed entry refuses to boot like every other setting.
			// `parseAllowList` throws on a bad CIDR, and re-parsing per caller put
			// that throw inside the delivery tick — where it logged every fifteen
			// seconds and delivered nothing — and inside the admin actions, which
			// 500'd the one surface an operator would use to fix it (spec §12).
			//
			// `egress/destination.ts` imports nothing but `node:dns` and
			// `node:net`, so this stays acyclic and this module stays testable
			// under plain Vitest.
			EVENT_EGRESS_ALLOW: blankAsUndefined(z.string().min(1).transform(parseAllowListOrIssue)),
			// Subsystem B's own kill switch (spec §11), independent of A's: a
			// deployment can ship events without ever shipping the audit log, or
			// the reverse.
			AUDIT_SINK_ENABLED: booleanFlag,
			AUDIT_SINK_BATCH_ROWS: z.coerce.number().int().positive().default(1000),
			// Minutes, not milliseconds: an operator reads and edits this value,
			// and the mapping below is the one place it becomes ms.
			AUDIT_SINK_BATCH_MAX_AGE: z.coerce.number().int().positive().default(15),
			AUDIT_SINK_BATCH_MAX_BYTES: z.coerce
				.number()
				.int()
				.positive()
				.default(8 * 1024 * 1024),
			// Hours, for the same reason AUDIT_SINK_BATCH_MAX_AGE is minutes.
			AUDIT_SINK_ATTEST_INTERVAL: z.coerce.number().int().positive().default(24),
			AUDIT_SINK_S3_BUCKET: blankAsUndefined(z.string().min(1)),
			AUDIT_SINK_S3_REGION: blankAsUndefined(z.string().min(1)),
			AUDIT_SINK_S3_ENDPOINT: blankAsUndefined(z.string().url()),
			AUDIT_SINK_S3_ACCESS_KEY_ID: blankAsUndefined(z.string().min(1)),
			AUDIT_SINK_S3_SECRET_ACCESS_KEY: blankAsUndefined(z.string().min(1)),
			AUDIT_SINK_S3_PREFIX: blankAsUndefined(z.string().min(1)),
			// `tls://host:6514` or `tcp://host:514`. UDP is absent by construction
			// rather than rejected by a rule, because silent loss disqualifies a
			// compliance record and there must be no variable that re-enables it
			// (spec §5.3).
			AUDIT_SINK_SYSLOG_URL: blankAsUndefined(
				z
					.string()
					.min(1)
					.refine((value) => /^tls:\/\/|^tcp:\/\//.test(value), {
						message: 'AUDIT_SINK_SYSLOG_URL must start with tls:// or tcp:// — UDP is not supported'
					})
					.refine(isValidUrl, { message: 'AUDIT_SINK_SYSLOG_URL is not a valid URL' })
					.refine(hasHost, { message: 'AUDIT_SINK_SYSLOG_URL must include a host' })
			),
			AUDIT_SINK_SYSLOG_CA: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_CLIENT_CERT: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_CLIENT_KEY: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_FACILITY: blankAsUndefined(z.enum(SYSLOG_FACILITIES)).default('local0'),
			// 8 KiB, matching rsyslog's default. A row above it fails the batch
			// rather than being truncated: a truncated row can never reproduce
			// its digest (spec §5.3).
			AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES: blankAsUndefined(
				z.coerce.number().int().positive()
			).default(8192)
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

			// b67569e's lesson from EVENT_EGRESS_ALLOW: a malformed setting that
			// boots clean throws inside every tick instead, and 500s the admin
			// page an operator would use to fix it. Both failures below refuse to
			// boot instead.
			const s3Fields = [
				value.AUDIT_SINK_S3_BUCKET,
				value.AUDIT_SINK_S3_REGION,
				value.AUDIT_SINK_S3_ACCESS_KEY_ID,
				value.AUDIT_SINK_S3_SECRET_ACCESS_KEY
			];
			const s3FieldsSet = s3Fields.filter((field) => field !== undefined).length;

			const anySinkConfigured = s3FieldsSet > 0 || value.AUDIT_SINK_SYSLOG_URL !== undefined;

			if (value.AUDIT_SINK_ENABLED && !anySinkConfigured) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_ENABLED'],
					message:
						'AUDIT_SINK_ENABLED is true but no sink is configured — set the AUDIT_SINK_S3_* ' +
						'or AUDIT_SINK_SYSLOG_* variables'
				});
			} else if (s3FieldsSet > 0 && s3FieldsSet < s3Fields.length) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_S3_BUCKET'],
					message:
						'AUDIT_SINK_S3_BUCKET, AUDIT_SINK_S3_REGION, AUDIT_SINK_S3_ACCESS_KEY_ID and ' +
						'AUDIT_SINK_S3_SECRET_ACCESS_KEY must all be set together, or none at all'
				});
			}

			// Half of a mutual-TLS pair is not a weaker configuration, it is a
			// handshake that fails on every tick — the same reasoning the S3
			// group rule above carries.
			const clientPair = [value.AUDIT_SINK_SYSLOG_CLIENT_CERT, value.AUDIT_SINK_SYSLOG_CLIENT_KEY];
			const clientPairSet = clientPair.filter((field) => field !== undefined).length;

			if (clientPairSet === 1) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_SYSLOG_CLIENT_CERT'],
					message:
						'AUDIT_SINK_SYSLOG_CLIENT_CERT and AUDIT_SINK_SYSLOG_CLIENT_KEY must be set ' +
						'together, or neither'
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
			headers: parsed.OTEL_EXPORTER_OTLP_HEADERS ?? {},
			sampleRatio: parsed.OTEL_TRACES_SAMPLER_ARG
		},
		egress: {
			enabled: parsed.EVENT_EGRESS_ENABLED,
			signingKey: parsed.EVENT_SIGNING_KEY,
			allow: parsed.EVENT_EGRESS_ALLOW ?? []
		},
		auditSink: {
			enabled: parsed.AUDIT_SINK_ENABLED,
			batchRows: parsed.AUDIT_SINK_BATCH_ROWS,
			maxAgeMs: parsed.AUDIT_SINK_BATCH_MAX_AGE * 60_000,
			maxBytes: parsed.AUDIT_SINK_BATCH_MAX_BYTES,
			attestIntervalMs: parsed.AUDIT_SINK_ATTEST_INTERVAL * 60 * 60_000,
			s3: parsed.AUDIT_SINK_S3_BUCKET
				? {
						bucket: parsed.AUDIT_SINK_S3_BUCKET,
						region: parsed.AUDIT_SINK_S3_REGION!,
						endpoint: parsed.AUDIT_SINK_S3_ENDPOINT,
						accessKeyId: parsed.AUDIT_SINK_S3_ACCESS_KEY_ID!,
						secretAccessKey: parsed.AUDIT_SINK_S3_SECRET_ACCESS_KEY!,
						prefix: parsed.AUDIT_SINK_S3_PREFIX
					}
				: undefined,
			syslog: parsed.AUDIT_SINK_SYSLOG_URL
				? (() => {
						const url = new URL(parsed.AUDIT_SINK_SYSLOG_URL!);
						const tls = url.protocol === 'tls:';

						return {
							url: parsed.AUDIT_SINK_SYSLOG_URL!,
							tls,
							// `URL#hostname` keeps the brackets an IPv6 literal is written
							// with (`[::1]`), but `net.connect` does not strip them and
							// fails `getaddrinfo ENOTFOUND [::1]` forever rather than
							// connecting.
							host: url.hostname.replace(/^\[|\]$/g, ''),
							// The scheme's default, because an operator who writes
							// `tls://siem.example.com` means 6514 and should not have to
							// say so.
							port: url.port ? Number(url.port) : tls ? 6514 : 514,
							ca: parsed.AUDIT_SINK_SYSLOG_CA,
							clientCert: parsed.AUDIT_SINK_SYSLOG_CLIENT_CERT,
							clientKey: parsed.AUDIT_SINK_SYSLOG_CLIENT_KEY,
							facility: parsed.AUDIT_SINK_SYSLOG_FACILITY,
							maxMessageBytes: parsed.AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES
						};
					})()
				: undefined
		}
	};
}
