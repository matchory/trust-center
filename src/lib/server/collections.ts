/**
 * Two accumulators for the shape every batched read in this codebase ends in:
 * one query returns the children of many parents, and the caller needs them
 * back keyed by parent id.
 *
 * They live here rather than beside their first caller because the alternative
 * is what happened before: `content/documents.ts` kept `groupByKey` private and
 * every later module rewrote it inline as
 * `map.set(k, [...(map.get(k) ?? []), v])` — which is also quadratic, since it
 * reallocates the bucket on every row.
 */
export function groupByKey<T, K extends string>(
	rows: readonly T[],
	key: (row: T) => K
): Map<K, T[]> {
	const map = new Map<K, T[]>();
	for (const row of rows) {
		const bucket = map.get(key(row));
		if (bucket) bucket.push(row);
		else map.set(key(row), [row]);
	}
	return map;
}

/** `groupByKey(...).get(k)?.length`, for a caller that only wants the count. */
export function countByKey<T, K extends string>(
	rows: readonly T[],
	key: (row: T) => K
): Map<K, number> {
	const map = new Map<K, number>();
	for (const row of rows) {
		const k = key(row);
		map.set(k, (map.get(k) ?? 0) + 1);
	}
	return map;
}
