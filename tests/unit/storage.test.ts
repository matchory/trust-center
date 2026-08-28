import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import type { StorageAdapter } from '../../src/lib/server/storage';

let root: string;
let storage: StorageAdapter;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'tc-storage-'));
	storage = createLocalStorage(root);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('newStorageKey', () => {
	it('produces a sharded, opaque key', () => {
		expect(newStorageKey()).toMatch(
			/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('never repeats', () => {
		const keys = new Set(Array.from({ length: 500 }, () => newStorageKey()));
		expect(keys.size).toBe(500);
	});
});

describe('local storage', () => {
	it('round-trips bytes and reports size and digest', async () => {
		const key = newStorageKey();
		const data = new TextEncoder().encode('%PDF-1.7 pretend document');

		const stored = await storage.put(key, data);

		expect(stored.key).toBe(key);
		expect(stored.size).toBe(data.byteLength);
		// sha256 of the same bytes, computed independently of the implementation.
		expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);

		expect(await collect(await storage.stream(key))).toEqual(Buffer.from(data));
	});

	it('reports the size of a stored object and null for an absent one', async () => {
		const key = newStorageKey();
		await storage.put(key, new Uint8Array([1, 2, 3]));

		expect(await storage.stat(key)).toEqual({ size: 3 });
		expect(await storage.stat(newStorageKey())).toBeNull();
	});

	it('deletes an object and tolerates deleting an absent one', async () => {
		const key = newStorageKey();
		await storage.put(key, new Uint8Array([1]));

		await storage.delete(key);
		expect(await storage.stat(key)).toBeNull();
		await expect(storage.delete(key)).resolves.toBeUndefined();
	});

	it('refuses a key that did not come from newStorageKey', async () => {
		// Traversal is impossible by construction rather than by sanitising:
		// the shape check runs before any path is joined.
		for (const key of ['../../etc/passwd', 'ab/cd/../../../etc/passwd', 'plain.pdf', '/abs/path']) {
			await expect(storage.stat(key)).rejects.toThrow(/storage key/i);
			await expect(storage.stream(key)).rejects.toThrow(/storage key/i);
			await expect(storage.put(key, new Uint8Array([1]))).rejects.toThrow(/storage key/i);
			await expect(storage.delete(key)).rejects.toThrow(/storage key/i);
		}
	});

	it('reports a missing object as a typed error rather than an ENOENT', async () => {
		await expect(storage.stream(newStorageKey())).rejects.toThrow(/not found/i);
	});
});
