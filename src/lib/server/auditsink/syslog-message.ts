/**
 * RFC 5424 message construction and RFC 6587 octet-counting framing, kept
 * apart from the socket so the wire format is testable without one — the
 * header fields are where a receiver silently rejects or misfiles a message,
 * and that is not a property a mocked socket can assert (spec §5.3).
 */

/** RFC 5424 §6.2.1, in numeric order, restricted to the facilities an
 * application may legitimately claim. Kernel, mail, news, uucp and cron are
 * omitted: they are the system's to write, not ours. */
export const SYSLOG_FACILITIES = [
	'user',
	'daemon',
	'auth',
	'syslog',
	'authpriv',
	'ftp',
	'local0',
	'local1',
	'local2',
	'local3',
	'local4',
	'local5',
	'local6',
	'local7'
] as const;

/** Kept a literal record — rather than derived from SYSLOG_FACILITIES by
 * index — so the numeric codes stay visually checkable against RFC 5424
 * §6.2.1 next to the names, and typed against the tuple so it errors if a
 * name is ever added to one but not the other. */
const FACILITY_CODES: Record<(typeof SYSLOG_FACILITIES)[number], number> = {
	user: 1,
	daemon: 3,
	auth: 4,
	syslog: 5,
	authpriv: 10,
	ftp: 11,
	local0: 16,
	local1: 17,
	local2: 18,
	local3: 19,
	local4: 20,
	local5: 21,
	local6: 22,
	local7: 23
};

/** `notice`, not `info` — decision D1. */
const SEVERITY_NOTICE = 5;

/** RFC 5424 field length caps (§6.2). Exceeding one is a rejected message at
 * a strict receiver, so they are enforced here rather than discovered. */
const MAX_HOSTNAME = 255;
const MAX_APP_NAME = 48;
const MAX_PROC_ID = 128;
const MAX_MSG_ID = 32;

export const APP_NAME = 'trustcenter';

export function facilityCode(name: string): number {
	const code = (FACILITY_CODES as Record<string, number | undefined>)[name];
	if (code === undefined) throw new Error(`unknown syslog facility: ${name}`);

	return code;
}

export interface MessageParams {
	facility: string;
	hostname: string;
	procId: string;
	msgId: string;
	timestamp: Date;
	message: string;
}

/** RFC 5424 requires a printable-ASCII field, and `-` where there is no
 * value. A field that is empty or over its cap becomes nil rather than
 * producing a message a strict receiver drops. */
function field(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) return '-';

	return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : '-';
}

export function buildMessage(params: MessageParams): string {
	const pri = facilityCode(params.facility) * 8 + SEVERITY_NOTICE;
	const header = [
		`<${pri}>1`,
		params.timestamp.toISOString(),
		field(params.hostname, MAX_HOSTNAME),
		field(APP_NAME, MAX_APP_NAME),
		field(params.procId, MAX_PROC_ID),
		field(params.msgId, MAX_MSG_ID),
		// Structured data is nil: a private SD-ID needs a registered enterprise
		// number, and PROCID already carries the batch correlation it would
		// have held (decisions D4, D6).
		'-'
	].join(' ');

	// RFC 5424 §6.4: a UTF-8 BOM prefix on MSG tells the receiver the encoding
	// unambiguously. Written as the \ufeff escape, never the literal byte, so
	// the source stays legible and copy-safe.
	return `${header} \ufeff${params.message}`;
}

/** Thrown with no receiver data and no message content: `last_error` is
 * written to a table that forbids DELETE and is excluded from retention, so a
 * row's bytes must never reach it (spec §5.4, issue #11). */
export class MessageTooLarge extends Error {
	constructor(readonly bytes: number) {
		super('message exceeds the configured maximum');
		this.name = 'MessageTooLarge';
	}
}

/**
 * RFC 6587 octet counting — `MSG-LEN SP SYSLOG-MSG` — which is the only
 * unambiguous framing over a stream. The count is octets after UTF-8
 * encoding, not characters: counting characters would desynchronise the
 * receiver for every later message on the same connection.
 */
export function frame(message: string): Buffer {
	const body = Buffer.from(message, 'utf8');

	return Buffer.concat([Buffer.from(`${body.byteLength} `, 'ascii'), body]);
}
