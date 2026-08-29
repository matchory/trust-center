import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { z } from 'zod';
import { recordEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db/instance';
import { clientIp } from '../http/client-ip';
import type { Db } from '../db';

/**
 * One shape for every admin action failure, so a form narrows on `field` alone.
 * `message` carries a reason the form cannot derive from the field name — an
 * upload rejected for its type or size is the case that needs it.
 */
export type AdminActionFailure = { field: string; locale?: string; message?: string };

/**
 * Meta edits and translation edits are distinct occurrences and get distinct
 * action names. Phase 1 wrote `<type>.updated` for both and distinguished them
 * only by the shape of `meta`, which no audit filter can express. The log is
 * append-only, so this convention is permanent from here.
 */
export function translationAction(type: string): string {
	return `${type}.translation.updated`;
}

/**
 * "Became visible to anyone who asks" is a question worth answering directly,
 * so each content type names the predicate that makes it public. Types with no
 * such notion pass `undefined` and always record `.updated`.
 */
export function resolveMetaAction<T>(
	type: string,
	data: T,
	isPublished: ((data: T) => boolean) | undefined
): string {
	return isPublished?.(data) ? `${type}.published` : `${type}.updated`;
}

/** The slice of a route event these helpers use; keeps them testable. */
type AdminEvent = Pick<RequestEvent, 'request' | 'locals' | 'getClientAddress'> & {
	params: { id: string };
};

interface SaveMetaOptions<S extends z.ZodType> {
	/** Action prefix, e.g. `'answer'` → `answer.updated`. */
	type: string;
	/**
	 * Audit subject type, when it differs from the action prefix. `update` posts
	 * are the case that forced this: their action reads `update.updated` while
	 * their subject is `update_post`, and collapsing the two would silently
	 * rewrite the subject of every existing row's successor.
	 */
	subjectType?: string;
	schema: S;
	/** Pulls the raw values out of the submitted form, before validation. */
	read: (form: FormData) => Record<string, unknown>;
	/**
	 * Performs the write. Deliberately receives `db` rather than closing over it,
	 * so a call site needing more than one statement — controls also replace
	 * their evidence set — does both here instead of forking the helper.
	 */
	update: (db: Db, id: string, data: z.output<S>) => Promise<unknown>;
	isPublished?: (data: z.output<S>) => boolean;
	/** Overrides what lands in the audit event's `meta`; defaults to the parsed data. */
	meta?: (data: z.output<S>) => Record<string, unknown>;
	/** Field reported when validation fails and Zod names no path. */
	fallbackField: string;
}

/**
 * parse → update → recordEvent, the shape all six content types agreed on.
 * Returns `{ saved: true }` or a `fail()` naming the offending field.
 */
export function saveMetaAction<S extends z.ZodType>(opts: SaveMetaOptions<S>) {
	return async (event: AdminEvent) => {
		const form = await event.request.formData();
		const parsed = opts.schema.safeParse(opts.read(form));

		if (!parsed.success) {
			return fail<AdminActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? opts.fallbackField)
			});
		}

		const data = parsed.data as z.output<S>;
		const db = getDb();
		await opts.update(db, event.params.id, data);

		await recordEvent(db, {
			action: resolveMetaAction(opts.type, data, opts.isPublished),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: opts.subjectType ?? opts.type,
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: opts.meta?.(data) ?? (data as Record<string, unknown>)
		});

		return { saved: true };
	};
}

interface SaveTranslationOptions {
	type: string;
	subjectType?: string;
	/** Trimmed and required. Order defines which is reported first on failure. */
	required: readonly string[];
	/**
	 * Trimmed, and empty means `null` rather than a validation failure — a
	 * document's summary and a control's description are genuinely optional, and
	 * requiring every field would have forced those two pages to fork.
	 */
	optional?: readonly string[];
	set: (
		db: Db,
		id: string,
		locale: string,
		values: Record<string, string | null>
	) => Promise<unknown>;
}

/**
 * The locale is validated against the *enabled* set, not the compiled set: a
 * compiled-but-disabled locale is not a locale on this deployment (spec §7).
 */
export function saveTranslationAction(opts: SaveTranslationOptions) {
	return async (event: AdminEvent) => {
		const form = await event.request.formData();
		const locale = String(form.get('locale') ?? '');

		if (!getConfig().locales.includes(locale)) {
			return fail<AdminActionFailure>(400, { field: 'locale' });
		}

		const values: Record<string, string | null> = {};

		for (const field of opts.required) {
			const value = String(form.get(field) ?? '').trim();
			if (!value) return fail<AdminActionFailure>(400, { field, locale });
			values[field] = value;
		}

		for (const field of opts.optional ?? []) {
			values[field] = String(form.get(field) ?? '').trim() || null;
		}

		const db = getDb();
		await opts.set(db, event.params.id, locale, values);

		await recordEvent(db, {
			action: translationAction(opts.type),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: opts.subjectType ?? opts.type,
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { locale }
		});

		return { saved: true };
	};
}
