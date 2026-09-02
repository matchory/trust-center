import type { UpdateKind } from '$lib/content-types';
import { m } from '$lib/paraglide/messages.js';

/**
 * A label per kind rather than one interpolated message: a kind is a database
 * value, and rendering it inside German copy would leave an English word in the
 * sentence. Shared, because three portal pages name kinds — a fifth kind should
 * not be a three-file edit.
 */
const LABELS: Record<UpdateKind, () => string> = {
	document: () => m.update_kind_document(),
	subprocessor: () => m.update_kind_subprocessor(),
	certification: () => m.update_kind_certification(),
	advisory: () => m.update_kind_advisory()
};

/** Called at render time, so it resolves per request like `PORTAL_SECTIONS`. */
export function updateKindLabel(kind: UpdateKind): string {
	return LABELS[kind]();
}
