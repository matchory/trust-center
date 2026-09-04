import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordEvent } from '../audit';
import { localizePath } from '../../i18n/locale';
import { getConfig } from '../config';
import {
	EGRESS_FORMATS,
	eventDelivery,
	eventEndpoint,
	eventEndpointFilter,
	type EgressFormat
} from '../db/schema';
import { postEvent } from './client';
import {
	EgressDestinationRejected,
	validateEndpointUrl,
	type AllowEntry,
	type LookupAll
} from './destination';
import { pendingDepthByEndpoint } from './deliver';
import { currentHorizon } from './fanout';
import { isValidPattern, matchesPattern, patternsByEndpoint } from './filter';
import { formatEvent, requiresSigning } from './format';
import { endpointSecret, eventHeaders } from './secret';
import type { Db } from '../db';
import type { EventModel } from './model';

/** What the list page may show. Deliberately no `url` — see `EndpointDetail`. */
export interface EndpointSummary {
	id: string;
	name: string;
	format: EgressFormat;
	/**
	 * The destination host and nothing else (spec §11). A Teams Workflows URL
	 * carries its shared secret in the query string, so the full URL belongs on
	 * the one page that edits it and nowhere else.
	 */
	host: string;
	enabled: boolean;
	disabledReason: string | null;
	lastSuccessAt: Date | null;
	lastOutcome: { status: string; statusCode: number | null } | null;
	pendingDepth: number;
	patterns: string[];
}

/** The summary plus the two fields only the edit form needs. */
export interface EndpointDetail extends EndpointSummary {
	url: string;
	secretVersion: number;
}

export interface EndpointInput {
	name: string;
	url: string;
	/**
	 * Unnarrowed, because `validate` is what narrows it. A route reading this
	 * off a form would otherwise have to re-check `EGRESS_FORMATS` purely to
	 * satisfy the type, which is a second copy of the rule that then has to
	 * agree with this module's.
	 */
	format: string;
	patterns: string[];
}

/**
 * The whole object defaults from `getConfig()` when omitted, so
 * `options === undefined` means "read the environment" and
 * `{ signingKey: undefined }` means "explicitly no key is configured". One
 * nullish convention: `AppConfig.egress.signingKey` and `DeliverOptions` both
 * use `undefined`, and `signingKey` is required here so a caller has to say
 * which it means.
 */
export interface EndpointOptions {
	signingKey: string | undefined;
	allow?: readonly AllowEntry[];
	/**
	 * `EVENT_EGRESS_ENABLED`. Only meaningful on the injection seam described
	 * above — when the whole object is omitted this comes from config, which is
	 * what the route does. Defaults to `true` so a test has to opt *out* of
	 * delivery rather than remember to opt in.
	 */
	enabled?: boolean;
}

export interface EndpointActor {
	staffUserId: string;
	ip: string | null;
}

/**
 * Carries the form field the message belongs to, so a route can
 * `fail(400, { field })` the way `/admin/settings/access` does rather than
 * turning an operator typo into a 500.
 */
export class EndpointInvalid extends Error {
	constructor(
		message: string,
		readonly field: 'name' | 'url' | 'format' | 'patterns' | 'id'
	) {
		super(message);
		this.name = 'EndpointInvalid';
	}
}

function resolved(options: EndpointOptions | undefined): {
	signingKey: string | undefined;
	allow: readonly AllowEntry[];
	enabled: boolean;
} {
	// The options branch is the injection seam: it exists so a test can drive
	// this without a configured environment, and reading `getConfig()` here
	// would defeat that. The route passes nothing, so the production test-send
	// takes the branch below and does read the switch.
	if (options) {
		return {
			signingKey: options.signingKey,
			allow: options.allow ?? [],
			enabled: options.enabled ?? true
		};
	}
	const config = getConfig();
	return {
		signingKey: config.egress.signingKey,
		allow: config.egress.allow,
		enabled: config.egress.enabled
	};
}

/**
 * Everything a write has to be true of, in one place and before any of it.
 * `validateEndpointUrl` is the same function the delivery path re-runs on
 * every attempt, so a URL that saves is a URL that can be attempted.
 */
function validate(
	input: EndpointInput,
	allow: readonly AllowEntry[],
	signingKey: string | undefined
): { name: string; format: EgressFormat; patterns: string[] } {
	const name = input.name.trim();
	if (name === '') throw new EndpointInvalid('a name is required', 'name');

	if (!(EGRESS_FORMATS as readonly string[]).includes(input.format)) {
		throw new EndpointInvalid(`${input.format} is not a supported format`, 'format');
	}
	const format = input.format as EgressFormat;

	try {
		validateEndpointUrl(input.url, allow);
	} catch (cause) {
		if (cause instanceof EgressDestinationRejected) {
			throw new EndpointInvalid(cause.message, 'url');
		}
		throw cause;
	}

	// An endpoint with no filters receives nothing, and silence that looks like
	// a save is the failure this refuses.
	const patterns = [...new Set(input.patterns.map((pattern) => pattern.trim()).filter(Boolean))];
	if (patterns.length === 0) {
		throw new EndpointInvalid('at least one pattern is required', 'patterns');
	}
	for (const pattern of patterns) {
		if (!isValidPattern(pattern)) {
			throw new EndpointInvalid(`${pattern} is not a valid pattern`, 'patterns');
		}
	}

	// This format's payload is what a consumer authenticates, so saving one with
	// no key configured would be the thing happening without its security
	// property (spec §7.1). Which formats those are is `requiresSigning`'s to
	// say — a literal here is what would silently not apply to a format added
	// later.
	if (requiresSigning(format) && signingKey === undefined) {
		throw new EndpointInvalid(
			`EVENT_SIGNING_KEY must be configured before a ${format} endpoint can be saved`,
			'format'
		);
	}

	return { name, format, patterns };
}

/**
 * The five endpoint writes all record against the same subject, with the same
 * actor shape and the same ip convention. One preamble so `subjectType` cannot
 * be mistyped on a sixth, and so §9's fixed set of action names is the only
 * thing a caller has to choose.
 *
 * `event_endpoint` events carry no requester personal data, and `meta` never
 * carries the URL — a Teams Workflows URL holds its shared secret in the query
 * string, and this table cannot be deleted from (spec §9).
 */
async function recordEndpointEvent(
	tx: Db,
	actor: EndpointActor,
	id: string,
	action: 'event_endpoint.created' | 'event_endpoint.updated' | 'event_endpoint.deleted',
	meta: Record<string, unknown>
): Promise<void> {
	await recordEvent(tx, {
		action,
		actor: { type: 'staff', id: actor.staffUserId },
		subjectType: 'event_endpoint',
		subjectId: id,
		ip: actor.ip ?? undefined,
		meta
	});
}

/** The host, or the raw string when a stored row somehow no longer parses. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

interface EndpointRow {
	id: string;
	name: string;
	url: string;
	format: EgressFormat;
	secretVersion: number;
	enabled: boolean;
	disabledReason: string | null;
	lastSuccessAt: Date | null;
}

/**
 * Turns endpoint rows into details, with the filters, the pending depth and
 * the newest delivery answered for the whole set at once rather than once per
 * row — three concurrent round trips regardless of how many endpoints exist.
 */
async function detail(db: Db, rows: EndpointRow[]): Promise<EndpointDetail[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);

	// None of the three reads takes input from another, so they go out together
	// rather than paying three serial round trips on every admin page render.
	const [patterns, depths, outcomes] = await Promise.all([
		patternsByEndpoint(db, ids),
		pendingDepthByEndpoint(db, ids),
		// Raw for the `DISTINCT ON`, which the query builder cannot express — but
		// the id list goes through `inArray` rather than a string-built array
		// literal, so the values stay parameters.
		db.execute(sql`
			SELECT DISTINCT ON (endpoint_id) endpoint_id, status, last_status_code
			FROM event_delivery
			WHERE ${inArray(eventDelivery.endpointId, ids)}
			ORDER BY endpoint_id, created_at DESC, id DESC
		`) as unknown as Promise<{ endpoint_id: string; status: string; last_status_code: number | null }[]>
	]);
	const outcomeByEndpoint = new Map(
		outcomes.map((row) => [
			row.endpoint_id,
			{ status: row.status, statusCode: row.last_status_code }
		])
	);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		url: row.url,
		format: row.format,
		host: hostOf(row.url),
		secretVersion: row.secretVersion,
		enabled: row.enabled,
		disabledReason: row.disabledReason,
		lastSuccessAt: row.lastSuccessAt,
		lastOutcome: outcomeByEndpoint.get(row.id) ?? null,
		pendingDepth: depths.get(row.id) ?? 0,
		patterns: patterns.get(row.id) ?? []
	}));
}

const COLUMNS = {
	id: eventEndpoint.id,
	name: eventEndpoint.name,
	url: eventEndpoint.url,
	format: sql<EgressFormat>`${eventEndpoint.format}`,
	secretVersion: eventEndpoint.secretVersion,
	enabled: eventEndpoint.enabled,
	disabledReason: eventEndpoint.disabledReason,
	lastSuccessAt: eventEndpoint.lastSuccessAt
};

/**
 * An allow-list rather than a rest-spread that drops `url`: a field added to
 * `EndpointDetail` later — another secret, say — then has to be named here
 * before it can reach the list page, instead of appearing there by default.
 */
function summarise(endpoint: EndpointDetail): EndpointSummary {
	return {
		id: endpoint.id,
		name: endpoint.name,
		format: endpoint.format,
		host: endpoint.host,
		enabled: endpoint.enabled,
		disabledReason: endpoint.disabledReason,
		lastSuccessAt: endpoint.lastSuccessAt,
		lastOutcome: endpoint.lastOutcome,
		pendingDepth: endpoint.pendingDepth,
		patterns: endpoint.patterns
	};
}

export async function listEndpoints(db: Db): Promise<EndpointSummary[]> {
	const rows = await db.select(COLUMNS).from(eventEndpoint).orderBy(eventEndpoint.name);
	return (await detail(db, rows)).map(summarise);
}

export async function getEndpoint(db: Db, id: string): Promise<EndpointDetail | undefined> {
	const rows = await db.select(COLUMNS).from(eventEndpoint).where(eq(eventEndpoint.id, id));
	return (await detail(db, rows))[0];
}

export async function createEndpoint(
	db: Db,
	input: EndpointInput,
	actor: EndpointActor,
	options?: EndpointOptions
): Promise<string> {
	const { signingKey, allow } = resolved(options);
	const { name, format, patterns } = validate(input, allow, signingKey);

	// One transaction, so a half-created endpoint — a row with no filters, or
	// filters an operator cannot see — cannot exist.
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(eventEndpoint)
			.values({
				name,
				url: input.url,
				format,
				// Not zero: a new endpoint must not replay eighteen months of
				// history into a Teams channel on its first tick (spec §2.1).
				cursorXmin: await currentHorizon(tx),
				cursorSeq: 0n
			})
			.returning({ id: eventEndpoint.id });
		const id = row!.id;

		await tx
			.insert(eventEndpointFilter)
			.values(patterns.map((pattern) => ({ endpointId: id, pattern })));

		await recordEndpointEvent(tx, actor, id, 'event_endpoint.created', { name, format, patterns });

		return id;
	});
}

export async function updateEndpoint(
	db: Db,
	id: string,
	input: EndpointInput,
	actor: EndpointActor,
	options?: EndpointOptions
): Promise<void> {
	const { signingKey, allow } = resolved(options);
	const { name, format, patterns } = validate(input, allow, signingKey);

	await db.transaction(async (tx) => {
		// The cursor is deliberately untouched: an operator narrowing a filter is
		// not asking to re-send anything.
		const updated = await tx
			.update(eventEndpoint)
			.set({ name, url: input.url, format })
			.where(eq(eventEndpoint.id, id))
			.returning({ id: eventEndpoint.id });
		if (updated.length === 0) throw new EndpointInvalid('no such endpoint', 'id');

		// Replaced wholesale rather than diffed: the filter set is small, and a
		// diff is where "the pattern I removed is still selected" comes from.
		await tx.delete(eventEndpointFilter).where(eq(eventEndpointFilter.endpointId, id));
		await tx
			.insert(eventEndpointFilter)
			.values(patterns.map((pattern) => ({ endpointId: id, pattern })));

		await recordEndpointEvent(tx, actor, id, 'event_endpoint.updated', { name, format, patterns });
	});
}

export async function deleteEndpoint(db: Db, id: string, actor: EndpointActor): Promise<void> {
	await db.transaction(async (tx) => {
		// Delete first, then record. `audit_event` has no foreign key to
		// `event_endpoint` — deliberately, so the event outlives the row it
		// names — which means either order works; this one is chosen because it
		// writes an event only for a delete that actually claimed a row.
		const [deleted] = await tx
			.delete(eventEndpoint)
			.where(eq(eventEndpoint.id, id))
			.returning({ name: eventEndpoint.name, format: eventEndpoint.format });
		if (!deleted) throw new EndpointInvalid('no such endpoint', 'id');

		await recordEndpointEvent(tx, actor, id, 'event_endpoint.deleted', {
			name: deleted.name,
			format: deleted.format
		});
	});
}

export async function setEndpointEnabled(
	db: Db,
	id: string,
	input: { enabled: boolean; skipBacklog?: boolean; reason?: string },
	actor: EndpointActor
): Promise<void> {
	await db.transaction(async (tx) => {
		// `enabled` and `disabled_at` move together or `event_endpoint_disabled_check`
		// rejects the row: "disabled" is one state, not two columns that usually
		// agree, and it always carries a reason.
		const reason = input.enabled ? null : input.reason?.trim() || 'disabled by an operator';
		const values: Record<string, unknown> = {
			enabled: input.enabled,
			disabledAt: input.enabled ? null : new Date(),
			disabledReason: reason
		};

		if (input.enabled && input.skipBacklog) {
			// A channel flooded with a day of stale notices is worse than a gap,
			// and `audit_event` remains the record of record either way — nothing
			// is lost, only un-notified (spec §5.5).
			values.cursorXmin = await currentHorizon(tx);
			values.cursorSeq = 0n;
		}

		const updated = await tx
			.update(eventEndpoint)
			.set(values)
			.where(eq(eventEndpoint.id, id))
			.returning({ id: eventEndpoint.id });
		if (updated.length === 0) throw new EndpointInvalid('no such endpoint', 'id');

		if (input.enabled && input.skipBacklog) {
			// `skipped` rather than a delete, so the gap is visible afterwards.
			await tx
				.update(eventDelivery)
				.set({ status: 'skipped', lastStatusCode: null, lastError: null })
				.where(and(eq(eventDelivery.endpointId, id), eq(eventDelivery.status, 'pending')));
		}

		// `updated`, not a fifth action name: §9 fixes the four an endpoint may
		// ever carry, and they are permanent once written.
		await recordEndpointEvent(tx, actor, id, 'event_endpoint.updated', {
			enabled: input.enabled,
			reason,
			skippedBacklog: input.skipBacklog === true
		});
	});
}

export async function bumpSecretVersion(db: Db, id: string, actor: EndpointActor): Promise<number> {
	return db.transaction(async (tx) => {
		// Incremented in SQL rather than read-then-write: two admins rotating at
		// once must not land on the same version.
		const [row] = await tx
			.update(eventEndpoint)
			.set({ secretVersion: sql`${eventEndpoint.secretVersion} + 1` })
			.where(eq(eventEndpoint.id, id))
			.returning({ secretVersion: eventEndpoint.secretVersion });
		if (!row) throw new EndpointInvalid('no such endpoint', 'id');

		await recordEndpointEvent(tx, actor, id, 'event_endpoint.updated', {
			secretVersion: row.secretVersion
		});

		return row.secretVersion;
	});
}

/**
 * Roughly thirty events a day — the point at which a channel is being written
 * to more than it is read. A judgement call, so it is a constant with its
 * reasoning rather than a literal in a template: `document.downloaded` is
 * registered and deliberately not throttled, because throttling here would be
 * this subsystem deciding what an operator's channel should contain. The
 * operator chooses, and is told what they are choosing (spec §9.1).
 */
export const HIGH_FREQUENCY_WEEKLY_EVENTS = 200;

/**
 * The patterns an operator has selected that are above the threshold, with the
 * weekly count each one actually carries.
 *
 * A pure function rather than six lines inside the page `load`, because that
 * is the only shape in which §9.1's behaviour can be asserted at all — the
 * arithmetic that decides whether an operator is warned should not be
 * reachable exclusively through a route.
 *
 * Summed across every action a pattern matches, not per action: an operator
 * who selects `document.*` is choosing the total of what that expands to, and
 * warning on the largest single action would understate what they signed up
 * for.
 */
export function highFrequencyPatterns(
	patterns: readonly string[],
	rates: Record<string, number>
): { pattern: string; weekly: number }[] {
	return patterns
		.map((pattern) => ({
			pattern,
			weekly: Object.entries(rates)
				.filter(([action]) => matchesPattern(pattern, action))
				.reduce((total, [, count]) => total + count, 0)
		}))
		.filter((entry) => entry.weekly > HIGH_FREQUENCY_WEEKLY_EVENTS);
}

/** How often each action was written over the last seven days. */
export async function actionRates(db: Db): Promise<Record<string, number>> {
	const rows = (await db.execute(sql`
		SELECT action, count(*)::int AS n
		FROM audit_event
		WHERE at > now() - interval '7 days'
		GROUP BY action
	`)) as unknown as { action: string; n: number }[];

	return Object.fromEntries(rows.map((row) => [row.action, row.n]));
}

/**
 * `EndpointOptions` plus the resolver seam. Extended rather than restated: the
 * two differed only by `lookup`, and a second copy is how one of them comes to
 * be missing a field `resolved()` reads — which is exactly how `enabled` would
 * have been forgotten here.
 */
export interface TestEventOptions extends EndpointOptions {
	/** Test seam, as on `DeliverOptions`. Never set by a route. */
	lookup?: LookupAll;
}

/**
 * The endpoint's current signing secret, hex-encoded for the operator to paste
 * into their consumer.
 *
 * Here rather than in the route that renders it: the route would otherwise
 * hold the derivation's inputs and its wire encoding, so a change to the
 * scheme — another input, a KDF, a v2 — would have to be made outside the
 * module it belongs to and outside the tests that cover it. The return is
 * shaped like `sendTestEvent`'s so "no key is configured" reaches the page as
 * its own reason instead of being borrowed onto a form field it is not about.
 */
export async function revealEndpointSecret(
	db: Db,
	id: string,
	options?: EndpointOptions
): Promise<{ secret: string } | { reason: 'signing_key_missing' }> {
	const { signingKey } = resolved(options);
	if (signingKey === undefined) return { reason: 'signing_key_missing' };

	const [endpoint] = await db
		.select({ secretVersion: eventEndpoint.secretVersion })
		.from(eventEndpoint)
		.where(eq(eventEndpoint.id, id));
	if (!endpoint) throw new EndpointInvalid('no such endpoint', 'id');

	return { secret: endpointSecret(signingKey, id, endpoint.secretVersion).toString('hex') };
}

/**
 * Renders a synthetic model and delivers it inline. The only way an operator
 * learns their URL is wrong before a real access request does.
 *
 * It bypasses **exactly three** things — the cursor, the filter and the queue.
 * The destination check, the scheme and port restrictions, the redirect
 * refusal and the discard-the-body rule all apply unchanged, because an
 * inline admin-triggered request that skipped them would be a hand-built SSRF
 * probe with a UI (spec §11). That is why this goes through `postEvent` and
 * `validateEndpointUrl` rather than issuing its own request.
 *
 * `egress.test` is deliberately not an audit action: nothing writes it to
 * `audit_event`, so no filter can match it and no loop can start (spec §9).
 * No `event_delivery` row is written either — nothing retries a test send.
 */
export async function sendTestEvent(
	db: Db,
	id: string,
	options?: TestEventOptions
): Promise<{ statusCode: number | null; reason: string | null }> {
	const [endpoint] = await db
		.select({
			url: eventEndpoint.url,
			// Typed at the read, as `COLUMNS` does, so neither the signing check
			// below nor `formatEvent` needs a cast at its call site.
			format: sql<EgressFormat>`${eventEndpoint.format}`,
			secretVersion: eventEndpoint.secretVersion
		})
		.from(eventEndpoint)
		.where(eq(eventEndpoint.id, id));
	if (!endpoint) throw new EndpointInvalid('no such endpoint', 'id');

	const { signingKey, allow, enabled } = resolved(options);
	// `defaultLocale` for the reason the delivery path gives for reading the
	// same value: the audience of an egress payload is the operator's own
	// staff, not the requester (spec §3.2).
	const { baseUrl, defaultLocale: locale } = getConfig();

	if (requiresSigning(endpoint.format) && signingKey === undefined) {
		return { statusCode: null, reason: 'signing_key_missing' };
	}

	const model: EventModel = {
		action: 'egress.test',
		at: new Date(),
		eventId: crypto.randomUUID(),
		// No audit row exists for a test send, and `0` is the one seq a real
		// event never has — a consumer ordering on it sorts this first rather
		// than into the middle of its history.
		seq: '0',
		// A fresh id because that is what the field means on the wire: the
		// consumer's idempotency key. Nothing is stored and nothing retries, so
		// it costs a UUID.
		deliveryId: crypto.randomUUID(),
		subject: null,
		actor: { type: 'staff', id: null },
		verified: false,
		data: {},
		summary: 'Test event from the trust center. Nothing happened.',
		// Through `localizePath` like every link `enrich.ts` builds: every page
		// URL in this application is locale-prefixed, and an unprefixed one
		// reaches the operator as a 302 rather than a page.
		link: `${baseUrl}${localizePath(`/admin/settings/integrations/${id}`, locale)}`
	};

	const { body, contentType } = formatEvent(endpoint.format, model);

	// The same headers the delivery path sends, rotation overlap included: a
	// test send that signed differently could not prove a rotation worked.
	const headers = eventHeaders({
		action: model.action,
		deliveryId: model.deliveryId,
		endpointId: id,
		secretVersion: endpoint.secretVersion,
		signingKey,
		body
	});

	// The stored URL, unvalidated: `postEvent` owns both the kill switch and
	// `validateEndpointUrl`, so an admin-triggered send cannot be the call site
	// that skips either (spec §11).
	const outcome = await postEvent({
		url: endpoint.url,
		enabled,
		allow,
		body,
		contentType,
		headers,
		lookup: options?.lookup
	});

	return outcome.kind === 'delivered'
		? { statusCode: outcome.statusCode, reason: null }
		: { statusCode: outcome.statusCode, reason: outcome.reason };
}
