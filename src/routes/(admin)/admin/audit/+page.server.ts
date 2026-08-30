import { error } from '@sveltejs/kit';
import { queryEvents, type AuditFilter } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 100;

/** The four `actor_type` values the CHECK constraint permits. */
const ACTOR_TYPES = ['staff', 'staff-unresolved', 'requester', 'system'] as const;

function text(params: URLSearchParams, key: string): string {
	return params.get(key)?.trim() ?? '';
}

/**
 * A `<input type="date">` submits `YYYY-MM-DD` or nothing. Anything else is a
 * hand-edited URL: it is dropped rather than 400'd, because a filter that
 * cannot be parsed is not an attack and the page still has something to show.
 * `to` covers the whole day — an auditor asking for "up to the 5th" means the
 * end of the 5th, not its first instant.
 */
function day(value: string, endOfDay: boolean): Date | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// Admin only, not approver: the log carries every actor's IP and the full
	// history of the deployment, which is more than triage needs.
	if (locals.staff?.role !== 'admin') {
		error(403, 'The audit log is restricted to administrators.');
	}

	const params = url.searchParams;
	const action = text(params, 'action');
	const actorTypeParam = text(params, 'actorType');
	const actorType = (ACTOR_TYPES as readonly string[]).includes(actorTypeParam)
		? actorTypeParam
		: '';
	const from = text(params, 'from');
	const to = text(params, 'to');
	const before = text(params, 'before');

	const filter: AuditFilter = {
		action: action || undefined,
		actorType: actorType || undefined,
		from: day(from, false),
		to: day(to, true),
		beforeSeq: /^\d+$/.test(before) ? BigInt(before) : undefined,
		// One more than the page, so the presence of a next page is known
		// without a second count query over a table that only grows.
		limit: PAGE_SIZE + 1
	};

	const rows = await queryEvents(getDb(), filter);
	const page = rows.slice(0, PAGE_SIZE);

	let older: string | null = null;
	if (rows.length > PAGE_SIZE) {
		const next = new URLSearchParams(params);
		next.set('before', page.at(-1)!.seq.toString());
		older = `?${next.toString()}`;
	}

	return {
		// `seq` is a bigint and only ever leaves as a cursor, which the server
		// already built above; the rows carry it as a string so the payload
		// stays plain JSON.
		events: page.map((event) => ({ ...event, seq: event.seq.toString() })),
		filter: { action, actorType, from, to },
		actorTypes: ACTOR_TYPES,
		older
	};
};
