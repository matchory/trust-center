import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { SinkError } from './port';
import { buildMessage, frame, MessageTooLarge } from './syslog-message';
import type { Attestation, AuditSinkAdapter, SinkBatch } from './port';

/** Matches `TIMEOUT_MS` in s3.ts: one deadline for every sink, so a stalled
 * receiver and a stalled bucket look the same to the shipper's backoff. */
const TIMEOUT_MS = 30_000;

export interface SyslogSinkConfig {
	host: string;
	port: number;
	tls: boolean;
	ca?: string;
	clientCert?: string;
	clientKey?: string;
	facility: string;
	maxMessageBytes: number;
	/** The HOSTNAME field, from BASE_URL rather than os.hostname() (decision D2). */
	hostname: string;
}

/**
 * The closed-set reason for a socket failure (spec §5.4), assigned by the
 * first matching rule. Nothing from the cause reaches the SinkError: it is
 * written to a table that forbids DELETE and is excluded from retention, so a
 * receiver's message there outlives every erasure path (issue #11).
 *
 * Exported for the mapping test: a receiver that stalls for the full timeout
 * is too slow to test against a real socket, and `timeout` is separated from
 * `network` precisely so an operator's lookup points at a hung SIEM rather
 * than at their firewall.
 */
export function socketReason(cause: unknown): SinkError {
	const code = (cause as { code?: string } | null)?.code ?? '';
	const name = cause instanceof Error ? cause.name : '';

	// A certificate a private CA does not cover is a TLS failure, and reporting
	// it as `network` sends an operator to look at firewalls instead of at trust
	// configuration. ERR_SSL_* is in the list because a receiver that refuses
	// our client certificate reports itself that way and not under Node's
	// ERR_TLS_*: measured 2026-09-05, a rejecting server yields
	// ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED, and an unverifiable one
	// DEPTH_ZERO_SELF_SIGNED_CERT.
	if (
		code.startsWith('ERR_TLS') ||
		code.startsWith('ERR_SSL') ||
		code.startsWith('UNABLE_TO_') ||
		code.startsWith('CERT_') ||
		code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
		code === 'SELF_SIGNED_CERT_IN_CHAIN'
	) {
		return new SinkError('tls');
	}
	if (name === 'TimeoutError' || code === 'ETIMEDOUT') return new SinkError('timeout');

	// ECONNRESET and EPROTO stay `network` here: the phase they happened in is
	// what tells a refused client certificate from a receiver that went away
	// mid-batch, and only the caller below knows the phase.
	return new SinkError('network');
}

export function createSyslogAdapter(config: SyslogSinkConfig): AuditSinkAdapter {
	/**
	 * A reset between "TCP is up" and "the handshake finished" is the receiver
	 * refusing to negotiate — it reports no TLS code of its own, so the phase is
	 * the only thing that distinguishes it — and sending an operator to their
	 * firewall for that wastes the lookup §5.4 exists to make possible.
	 *
	 * Both ends of the window matter. A refusal before TCP is up (nothing
	 * listening, no route) never got far enough for trust to be the question and
	 * stays `network`. A reset after the handshake is a receiver that went away
	 * mid-batch, which is also `network`.
	 */
	function phaseReason(cause: unknown, connected: boolean, secure: boolean): SinkError {
		const reason = socketReason(cause);

		return reason.reason === 'network' && config.tls && connected && !secure
			? new SinkError('tls')
			: reason;
	}

	/**
	 * One connection per batch, closed after the last message (spec §5.3). A
	 * pooled connection would have to answer what a half-written batch means
	 * on a socket the next batch inherits, and there is no acknowledgement to
	 * resynchronise with.
	 */
	async function send(procId: string, messages: readonly { msgId: string; body: string }[]) {
		const frames = messages.map((entry) => {
			const message = buildMessage({
				facility: config.facility,
				hostname: config.hostname,
				procId,
				msgId: entry.msgId,
				timestamp: new Date(),
				message: entry.body
			});
			const framed = frame(message);

			// Checked for the whole batch before the socket opens, so an
			// oversized row later in the batch cannot leave a partial batch at
			// the receiver (spec §5.3, decision D8).
			if (framed.byteLength > config.maxMessageBytes) {
				throw new MessageTooLarge(framed.byteLength);
			}

			return framed;
		});

		await new Promise<void>((resolve, reject) => {
			let connected = false;
			let secure = !config.tls;
			const socket: Socket = config.tls
				? connectTls({
						host: config.host,
						port: config.port,
						ca: config.ca ? [config.ca] : undefined,
						cert: config.clientCert,
						key: config.clientKey,
						// Never disabled, and no variable exists to disable it
						// (spec §5.3). This line is the whole TLS posture.
						rejectUnauthorized: true
					})
				: connectTcp({ host: config.host, port: config.port });

			const fail = (cause: unknown) => {
				reject(phaseReason(cause, connected, secure));
				socket.destroy();
			};

			// The error carries ETIMEDOUT rather than being a bare Error, because
			// the reason is read off the code: a plain Error would be classified
			// `network` and send an operator to their firewall.
			socket.setTimeout(TIMEOUT_MS, () =>
				fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
			);
			socket.on('error', fail);
			// TCP connect and TLS handshake are tracked separately because the
			// window between them is what `phaseReason` reads.
			socket.on('connect', () => (connected = true));
			// Resolved on the peer's close, not on our own `end()` callback,
			// which only means the FIN was flushed locally. Syslog acknowledges
			// nothing, so the far end closing after our FIN is the strongest
			// evidence available that it took the batch — and it is what makes a
			// rejected client certificate or a mid-batch reset a failure rather
			// than a silent success: under TLS 1.3 both arrive only after the
			// writes appear to have succeeded. A reject already settled the
			// promise by the time destroy() lands us here.
			socket.on('close', () => resolve());
			socket.on(config.tls ? 'secureConnect' : 'connect', () => {
				secure = true;
				socket.write(Buffer.concat(frames), (error) => {
					if (error) return fail(error);
					socket.end();
				});
			});
		});
	}

	function guard<T>(work: () => Promise<T>): Promise<T> {
		return work().catch((cause: unknown) => {
			if (cause instanceof MessageTooLarge) throw new SinkError('config');
			if (cause instanceof SinkError) throw cause;
			throw socketReason(cause);
		});
	}

	return {
		name: 'syslog',
		async ship(batch: SinkBatch): Promise<null> {
			// The shared body, split back into the lines it was built from
			// (spec §5.1: one body for all sinks). The canonical format is
			// LF-terminated, so the trailing empty element is dropped rather
			// than sent as a message.
			const lines = Buffer.from(batch.body).toString('utf8').split('\n').filter(Boolean);

			await guard(() =>
				send(batch.id, [
					...lines.map((body) => ({ msgId: 'audit', body })),
					{ msgId: 'manifest', body: JSON.stringify(batch.manifest) }
				])
			);

			// No object key: a syslog receiver has nowhere to point an auditor,
			// and the batch id is already in `batch_id`.
			return null;
		},
		async attest(attestation: Attestation): Promise<void> {
			await guard(() =>
				send('attestation', [{ msgId: 'attest', body: JSON.stringify(attestation) }])
			);
		}
	};
}
