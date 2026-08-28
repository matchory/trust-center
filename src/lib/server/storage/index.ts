import { getConfig } from '../config';
import { createLocalStorage } from './local';

export interface StoredObject {
	key: string;
	size: number;
	/** Lowercase hex. Used as the download ETag and as tamper evidence. */
	sha256: string;
}

/**
 * The storage boundary (spec §6.4). Keys are opaque and generated; no method
 * accepts a caller-supplied filename, and no implementation may expose a
 * publicly reachable URL to an object (spec §6.5) — reads happen through the
 * audited download endpoint and nowhere else.
 */
export interface StorageAdapter {
	put(key: string, data: Uint8Array): Promise<StoredObject>;
	stream(key: string): Promise<ReadableStream<Uint8Array>>;
	stat(key: string): Promise<{ size: number } | null>;
	delete(key: string): Promise<void>;
}

export class StorageObjectNotFound extends Error {
	constructor(key: string) {
		super(`Stored object not found: ${key}`);
		this.name = 'StorageObjectNotFound';
	}
}

let cached: StorageAdapter | undefined;

/** Lazy, like getConfig() and getDb(): importing this must not require config. */
export function getStorage(): StorageAdapter {
	return (cached ??= createLocalStorage(getConfig().storageDir));
}

export { createLocalStorage, newStorageKey } from './local';
