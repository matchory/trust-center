import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';

export interface Material {
	cert: string;
	key: string;
}

/** A self-signed certificate that is also its own CA, so a test can pass it as
 * `ca` and exercise private-CA verification without a signing chain. */
export function selfSigned(commonName: string): Material {
	const dir = mkdtempSync(join(tmpdir(), 'syslog-tls-'));
	const keyPath = join(dir, 'key.pem');
	const certPath = join(dir, 'cert.pem');

	execFileSync('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		keyPath,
		'-out',
		certPath,
		'-days',
		'1',
		'-subj',
		`/CN=${commonName}`,
		'-addext',
		'subjectAltName=DNS:localhost,IP:127.0.0.1'
	]);

	return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

export interface SyslogServer {
	port: number;
	/** Complete RFC 6587 frames, unframed back into messages. */
	messages: string[];
	/** TCP connections accepted, counted before any handshake. An adapter that
	 * rejects a batch without opening a socket is the only way this stays zero,
	 * and unlike `messages` it cannot be zero merely because a discarded write
	 * never reached the wire. */
	connections: () => number;
	/** Closes the socket mid-stream once n complete frames have arrived, for the
	 * write-failure test. Zero closes on the first byte, which for a TLS client
	 * is its ClientHello — a receiver that refuses to negotiate. */
	closeAfter: (frames: number) => void;
	close: () => Promise<void>;
}

/**
 * A receiver on loopback that un-frames RFC 6587 octet counting, so the tests
 * assert what a real syslog server would parse rather than what the adapter
 * believes it wrote.
 */
export async function startSyslogServer(
	options: {
		tls?: Material;
		/** Set to require a client certificate, for the mutual-TLS test. */
		requireClientCert?: Material;
	} = {}
): Promise<SyslogServer> {
	const messages: string[] = [];
	const open = new Set<{ destroy: () => void }>();
	let accepted = 0;
	let closeAtFrame = Infinity;

	const onConnection = (socket: NodeJS.ReadWriteStream & { destroy: () => void }) => {
		let buffer = Buffer.alloc(0);
		open.add(socket);

		socket.on('data', (chunk: Buffer) => {
			if (messages.length >= closeAtFrame) return socket.destroy();
			buffer = Buffer.concat([buffer, chunk]);

			for (;;) {
				const space = buffer.indexOf(0x20);
				if (space < 0) return;

				const length = Number(buffer.subarray(0, space).toString('ascii'));
				if (!Number.isFinite(length)) return;
				if (buffer.byteLength < space + 1 + length) return;

				messages.push(buffer.subarray(space + 1, space + 1 + length).toString('utf8'));
				buffer = buffer.subarray(space + 1 + length);

				if (messages.length >= closeAtFrame) {
					socket.destroy();
					return;
				}
			}
		});
		socket.on('close', () => open.delete(socket));
		socket.on('error', () => undefined);
	};

	const server: TlsServer | TcpServer = options.tls
		? createTlsServer(
				{
					cert: options.tls.cert,
					key: options.tls.key,
					requestCert: options.requireClientCert !== undefined,
					rejectUnauthorized: options.requireClientCert !== undefined,
					ca: options.requireClientCert ? [options.requireClientCert.cert] : undefined
				},
				onConnection
			)
		: createTcpServer(onConnection);

	// On the raw server rather than in the connection handler, so a TLS
	// connection counts even when its handshake never completes.
	server.on('connection', () => (accepted += 1));
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port');

	return {
		port: address.port,
		messages,
		connections: () => accepted,
		closeAfter: (frames) => (closeAtFrame = frames),
		// Sockets are destroyed rather than waited on: `close()` fires its
		// callback only once every connection has ended, so a socket the adapter
		// abandoned on a failed batch would hang the suite's afterEach.
		close: () =>
			new Promise((resolve) => {
				for (const socket of open) socket.destroy();
				server.close(() => resolve());
			})
	};
}
