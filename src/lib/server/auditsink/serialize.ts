import { createHash } from 'node:crypto';

/** Bumped when AUDIT_COLUMNS changes, so historical objects stay unambiguous. */
export const SERIALIZATION_VERSION = 1;

/**
 * Every column of audit_event, in the order the wire format emits them.
 *
 * An explicit list rather than reflection over the row: adding a column to
 * audit_event must be a deliberate format-version bump, not a silent change to
 * every future digest (spec §4.1). The drift test in
 * tests/integration/auditsink-reader.test.ts fails if this disagrees with the
 * table.
 */
export const AUDIT_COLUMNS = [
	'id',
	'seq',
	'at',
	'actor_type',
	'actor_id',
	'action',
	'subject_type',
	'subject_id',
	'ip',
	'ua',
	'request_id',
	'meta'
] as const;

/**
 * Every value read as text, never through the driver's types (spec §4.1):
 * postgres-js hands back a millisecond-precision Date for a microsecond
 * timestamptz, parses jsonb numerics into IEEE doubles, and returns seq as a
 * string that JSON.stringify would throw on if it were a BigInt.
 */
export const AUDIT_SELECT = `
	id::text AS id,
	seq::text AS seq,
	to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
	actor_type, actor_id, action, subject_type, subject_id, ip, ua, request_id,
	meta::text AS meta
`;

export interface AuditRowText {
	id: string;
	seq: string;
	at: string;
	actor_type: string;
	actor_id: string | null;
	action: string;
	subject_type: string | null;
	subject_id: string | null;
	ip: string | null;
	ua: string | null;
	request_id: string | null;
	meta: string | null;
}

/**
 * One line per row: keys in AUDIT_COLUMNS order, no insignificant whitespace,
 * LF-terminated, UTF-8.
 *
 * `meta` is spliced in as raw text rather than re-serialized (plan C1). Round
 * tripping it through JSON.parse would convert an arbitrary-precision jsonb
 * numeric to a double — the corruption §4.1 exists to prevent — and jsonb's own
 * key normalization already makes the text deterministic.
 */
export function serializeBatch(rows: readonly AuditRowText[]): {
	/** ArrayBuffer-backed rather than the `ArrayBufferLike` default, so an
	 * adapter can hand it straight to fetch as a body. */
	body: Uint8Array<ArrayBuffer>;
	digest: string;
} {
	const lines = rows.map((row) => {
		const fields = AUDIT_COLUMNS.map((column) => {
			if (column === 'meta') return `"meta":${row.meta ?? 'null'}`;
			if (column === 'seq') return `"seq":${Number(row.seq)}`;

			const value = row[column] as string | null;
			return `${JSON.stringify(column)}:${value === null ? 'null' : JSON.stringify(value)}`;
		});

		return `{${fields.join(',')}}`;
	});

	const body = new TextEncoder().encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`);

	return { body, digest: createHash('sha256').update(body).digest('hex') };
}

/**
 * The seq span of a batch's rows. Both call sites need it and only one of them
 * can ever be handed an empty list — `rebuildBatch`, after a purge removed
 * every row in a batch's range — so the empty case lives here rather than
 * being remembered at one of two sites.
 */
export function seqRange(rows: readonly { seq: string }[]): { min: bigint; max: bigint } {
	if (rows.length === 0) return { min: 0n, max: 0n };

	const seqs = rows.map((row) => BigInt(row.seq));

	return {
		min: seqs.reduce((a, b) => (b < a ? b : a)),
		max: seqs.reduce((a, b) => (b > a ? b : a))
	};
}

export interface BatchManifest {
	version: number;
	batch_id: string;
	created_at: string;
	prev_cursor: { xmin: string; seq: string };
	cursor: { xmin: string; seq: string };
	row_count: number;
	min_seq: string;
	max_seq: string;
	byte_count: number;
	digest: string;
	digest_algorithm: 'sha256';
}

export interface ManifestInput {
	id: string;
	createdAt: string;
	prevCursor: { xmin: bigint; seq: bigint };
	cursor: { xmin: bigint; seq: bigint };
	rowCount: number;
	minSeq: bigint;
	maxSeq: bigint;
	byteCount: number;
	digest: string;
}

/** Cursors and seqs are strings: they are bigints, and a JSON number would be
 * a lie above 2^53 in a document an auditor may parse with any tool. */
export function buildManifest(input: ManifestInput): BatchManifest {
	return {
		version: SERIALIZATION_VERSION,
		batch_id: input.id,
		created_at: input.createdAt,
		prev_cursor: { xmin: String(input.prevCursor.xmin), seq: String(input.prevCursor.seq) },
		cursor: { xmin: String(input.cursor.xmin), seq: String(input.cursor.seq) },
		row_count: input.rowCount,
		min_seq: String(input.minSeq),
		max_seq: String(input.maxSeq),
		byte_count: input.byteCount,
		digest: input.digest,
		digest_algorithm: 'sha256'
	};
}
