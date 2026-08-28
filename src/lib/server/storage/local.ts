import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { StorageObjectNotFound, type StorageAdapter, type StoredObject } from './index';

const KEY_PATTERN =
	/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Opaque and sharded two levels deep, so a directory never accumulates more
 * entries than a filesystem enjoys. Derived from a UUID rather than from the
 * uploaded filename: a key carries no information about its contents, and
 * nothing an operator or a visitor supplies ever reaches a path.
 */
export function newStorageKey(): string {
	const id = randomUUID();
	return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}

function assertKey(key: string): void {
	if (!KEY_PATTERN.test(key)) {
		throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
	}
}

export function createLocalStorage(rootDir: string): StorageAdapter {
	const root = resolve(rootDir);
	const pathFor = (key: string) => join(root, key);

	return {
		async put(key: string, data: Uint8Array): Promise<StoredObject> {
			assertKey(key);
			const path = pathFor(key);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, data);

			return {
				key,
				size: data.byteLength,
				sha256: createHash('sha256').update(data).digest('hex')
			};
		},

		async stream(key: string): Promise<ReadableStream<Uint8Array>> {
			assertKey(key);
			if ((await this.stat(key)) === null) throw new StorageObjectNotFound(key);

			return Readable.toWeb(
				createReadStream(pathFor(key))
			) as unknown as ReadableStream<Uint8Array>;
		},

		async stat(key: string): Promise<{ size: number } | null> {
			assertKey(key);
			try {
				return { size: (await stat(pathFor(key))).size };
			} catch {
				return null;
			}
		},

		async delete(key: string): Promise<void> {
			assertKey(key);
			await rm(pathFor(key), { force: true });
		}
	};
}
