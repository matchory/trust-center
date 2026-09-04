import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export interface RecordedRequest {
	method: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * A one-off HTTP receiver on loopback. Exists so delivery, retry and header
 * assertions run against a real socket rather than a mocked `request` — the
 * properties under test here (a refused redirect, a discarded body, a timeout)
 * are all properties of the transport, and a mock would assert the mock.
 */
export async function startWebhookServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{
	url: string;
	port: number;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];

	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			requests.push({
				method: request.method ?? '',
				headers: request.headers as Record<string, string>,
				body: Buffer.concat(chunks).toString('utf8')
			});
			handler(request, response);
		});
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port assigned');

	return {
		url: `http://127.0.0.1:${address.port}/webhook`,
		port: address.port,
		requests,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, 'close');
		}
	};
}

/**
 * Owns the lifetime of every fixture server a test starts, so each suite
 * closes them in `afterEach` without repeating the bookkeeping.
 *
 * Lives here rather than beside the egress helpers so the DB-free unit suite
 * can use it too: this module imports `node:http` and nothing else, while
 * `helpers/egress.ts` pulls in the Drizzle schema.
 */
export function webhookFixture() {
	const stops: (() => Promise<void>)[] = [];

	return {
		serve: async (handler: Parameters<typeof startWebhookServer>[0]) => {
			const server = await startWebhookServer(handler);
			stops.push(server.close);
			return server;
		},
		closeAll: async () => {
			// Copied and cleared first so a failing close cannot leave a stale
			// entry that the next test's teardown closes a second time.
			const pending = stops.splice(0);
			await Promise.all(pending.map((stop) => stop()));
		}
	};
}
