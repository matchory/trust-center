import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_STATUSES, DOCUMENT_TIERS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { documentGroupIds, listGroups, setDocumentGroups } from '$lib/server/access/groups';
import { saveMetaAction, saveTranslationAction } from '$lib/server/admin/actions';
import type { AdminActionFailure } from '$lib/server/admin/actions';
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
import { clientIp } from '$lib/server/http/client-ip';
import { getStorage, newStorageKey } from '$lib/server/storage';
import { assertPdfPages, readUpload, UploadRejected } from '$lib/server/upload';
import type { Actions, PageServerLoad } from './$types';

const ALLOWED_UPLOAD_TYPES = ['application/pdf'] as const;

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const doc = await getDocumentForAdmin(db, params.id);
	if (!doc) error(404, 'Document not found');

	const [categories, groups, groupIds] = await Promise.all([
		listCategories(db),
		listGroups(db),
		documentGroupIds(db, params.id)
	]);

	return { document: doc, categories, groups, groupIds };
};

function optionalDate(value: FormDataEntryValue | null): Date | null {
	const text = String(value ?? '').trim();
	return text ? new Date(text) : null;
}

export const actions: Actions = {
	// No `isPublished` here: publication is `setStatus`'s business, and it
	// already records document.published. Deriving it from this form as well
	// would emit that event on an unrelated slug edit.
	saveMeta: saveMetaAction({
		type: 'document',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			categoryId: z.string().uuid(),
			tier: z.enum(DOCUMENT_TIERS),
			position: z.coerce.number().int(),
			groupIds: z.array(z.string().uuid()).default([])
		}),
		read: (form) => ({
			slug: form.get('slug'),
			categoryId: form.get('categoryId'),
			tier: form.get('tier'),
			position: form.get('position') ?? 0,
			groupIds: form.getAll('groupIds').map(String).filter(Boolean)
		}),
		update: async (db, id, data) => {
			const { groupIds, ...meta } = data;
			await updateDocument(db, id, meta);
			await setDocumentGroups(db, id, groupIds);
		},
		fallbackField: 'slug'
	}),

	saveTranslation: saveTranslationAction({
		type: 'document',
		required: ['title'],
		optional: ['summary'],
		set: (db, id, locale, values) =>
			setDocumentTranslation(db, id, locale, {
				title: values.title!,
				summary: values.summary ?? null
			})
	}),

	setStatus: async (event) => {
		const form = await event.request.formData();
		const parsed = z.enum(DOCUMENT_STATUSES).safeParse(form.get('status'));
		if (!parsed.success) return fail<AdminActionFailure>(400, { field: 'status' });

		const db = getDb();
		await updateDocument(db, event.params.id, { status: parsed.data });

		// Publication and archival get their own audit actions rather than
		// hiding inside document.updated: they are the events an auditor asks
		// about, and "when did this become public" must be answerable without
		// reading a meta blob.
		await recordEvent(db, {
			action: parsed.data === 'published' ? 'document.published' : 'document.archived',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'document',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { status: parsed.data }
		});

		return { saved: true };
	},

	uploadFile: async (event) => {
		const form = await event.request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale))
			return fail<AdminActionFailure>(400, { field: 'locale' });

		let upload;
		try {
			upload = await readUpload(form, 'file', {
				maxBytes: getConfig().maxUploadBytes,
				allowedTypes: ALLOWED_UPLOAD_TYPES
			});
			// Bytes are not what watermarking costs — see assertPdfPages. Checked
			// here rather than at download time, so a file that would be expensive
			// to serve never reaches storage in the first place.
			await assertPdfPages(upload.bytes, getConfig().maxPdfPages);
		} catch (cause) {
			if (cause instanceof UploadRejected)
				return fail<AdminActionFailure>(400, { field: 'file', message: cause.message });
			throw cause;
		}

		const stored = await getStorage().put(newStorageKey(), upload.bytes);
		const db = getDb();

		const fileId = await addDocumentFile(db, {
			documentId: event.params.id,
			locale,
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: upload.filename,
			contentType: upload.contentType,
			validFrom: optionalDate(form.get('validFrom')),
			validUntil: optionalDate(form.get('validUntil')),
			uploadedByStaffId: event.locals.staff!.id
		});

		await recordEvent(db, {
			action: 'document_file.uploaded',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: clientIp(event) ?? undefined,
			meta: {
				documentId: event.params.id,
				locale,
				sha256: stored.sha256,
				filename: upload.filename
			}
		});

		return { saved: true };
	},

	deleteFile: async (event) => {
		const form = await event.request.formData();
		const fileId = String(form.get('fileId'));

		const db = getDb();
		const storageKey = await deleteDocumentFile(db, fileId);
		if (storageKey) await getStorage().delete(storageKey);

		await recordEvent(db, {
			action: 'document_file.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: clientIp(event) ?? undefined,
			meta: { documentId: event.params.id }
		});

		return { saved: true };
	},

	remove: async (event) => {
		const db = getDb();
		const storageKeys = await deleteDocument(db, event.params.id);
		const storage = getStorage();
		for (const key of storageKeys) await storage.delete(key);

		await recordEvent(db, {
			action: 'document.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'document',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { files: storageKeys.length }
		});

		redirect(303, localizePath('/admin/documents', event.locals.locale));
	}
};
