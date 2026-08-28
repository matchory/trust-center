import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_STATUSES, DOCUMENT_TIERS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	addDocumentFile,
	deleteDocument,
	deleteDocumentFile,
	getDocumentForAdmin,
	listCategories,
	setDocumentTranslation,
	updateDocument
} from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import { getStorage, newStorageKey } from '$lib/server/storage';
import { readUpload, UploadRejected } from '$lib/server/upload';
import type { Actions, PageServerLoad } from './$types';

const ALLOWED_UPLOAD_TYPES = ['application/pdf'] as const;

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const doc = await getDocumentForAdmin(db, params.id);
	if (!doc) error(404, 'Document not found');

	return { document: doc, categories: await listCategories(db) };
};

function optionalDate(value: FormDataEntryValue | null): Date | null {
	const text = String(value ?? '').trim();
	return text ? new Date(text) : null;
}

/**
 * One shape for every action failure on this page, so the form can narrow on
 * `field` alone. Without a single type the payloads form a union whose members
 * disagree on which extra keys exist, and `form.locale` stops type-checking.
 */
type DocumentActionFailure = { field: string; locale?: string; message?: string };

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				categoryId: z.string().uuid(),
				tier: z.enum(DOCUMENT_TIERS),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				categoryId: form.get('categoryId'),
				tier: form.get('tier'),
				position: form.get('position') ?? 0
			});

		if (!parsed.success)
			return fail<DocumentActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});

		const db = getDb();
		await updateDocument(db, params.id, parsed.data);
		await recordEvent(db, {
			action: 'document.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale))
			return fail<DocumentActionFailure>(400, { field: 'locale' });

		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail<DocumentActionFailure>(400, { field: 'title', locale });

		const summary = String(form.get('summary') ?? '').trim() || null;

		const db = getDb();
		await setDocumentTranslation(db, params.id, locale, { title, summary });
		await recordEvent(db, {
			action: 'document.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { translation: locale }
		});

		return { saved: true };
	},

	setStatus: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z.enum(DOCUMENT_STATUSES).safeParse(form.get('status'));
		if (!parsed.success) return fail<DocumentActionFailure>(400, { field: 'status' });

		const db = getDb();
		await updateDocument(db, params.id, { status: parsed.data });

		// Publication and archival get their own audit actions rather than
		// hiding inside document.updated: they are the events an auditor asks
		// about, and "when did this become public" must be answerable without
		// reading a meta blob.
		await recordEvent(db, {
			action: parsed.data === 'published' ? 'document.published' : 'document.archived',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { status: parsed.data }
		});

		return { saved: true };
	},

	uploadFile: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale))
			return fail<DocumentActionFailure>(400, { field: 'locale' });

		let upload;
		try {
			upload = await readUpload(form, 'file', {
				maxBytes: getConfig().maxUploadBytes,
				allowedTypes: ALLOWED_UPLOAD_TYPES
			});
		} catch (cause) {
			if (cause instanceof UploadRejected)
				return fail<DocumentActionFailure>(400, { field: 'file', message: cause.message });
			throw cause;
		}

		const stored = await getStorage().put(newStorageKey(), upload.bytes);
		const db = getDb();

		const fileId = await addDocumentFile(db, {
			documentId: params.id,
			locale,
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: upload.filename,
			contentType: upload.contentType,
			validFrom: optionalDate(form.get('validFrom')),
			validUntil: optionalDate(form.get('validUntil')),
			uploadedByStaffId: locals.staff!.id
		});

		await recordEvent(db, {
			action: 'document_file.uploaded',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: getClientAddress(),
			meta: { documentId: params.id, locale, sha256: stored.sha256, filename: upload.filename }
		});

		return { saved: true };
	},

	deleteFile: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const fileId = String(form.get('fileId'));

		const db = getDb();
		const storageKey = await deleteDocumentFile(db, fileId);
		if (storageKey) await getStorage().delete(storageKey);

		await recordEvent(db, {
			action: 'document_file.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: getClientAddress(),
			meta: { documentId: params.id }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		const storageKeys = await deleteDocument(db, params.id);
		const storage = getStorage();
		for (const key of storageKeys) await storage.delete(key);

		await recordEvent(db, {
			action: 'document.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { files: storageKeys.length }
		});

		redirect(303, localizePath('/admin/documents', locals.locale));
	}
};
