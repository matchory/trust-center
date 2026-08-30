import { fail } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	getBranding,
	parseBranding,
	setBranding,
	type Branding
} from '$lib/server/content/branding';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { getStorage, newStorageKey } from '$lib/server/storage';
import { readUpload, UploadRejected } from '$lib/server/upload';
import type { Actions, PageServerLoad } from './$types';

const LOGO_TYPES = ['image/png', 'image/svg+xml', 'image/webp'] as const;

export const load: PageServerLoad = async () => ({ branding: await getBranding(getDb()) });

const optionalText = (value: FormDataEntryValue | null): string | null =>
	String(value ?? '').trim() || null;

export const actions: Actions = {
	default: async (event) => {
		const { request, locals } = event;
		const form = await request.formData();
		const db = getDb();
		const current = await getBranding(db);

		let logoStorageKey = current.logoStorageKey;
		let logoContentType = current.logoContentType;
		let uploaded = false;

		// The file field is optional: an empty one means "keep the current logo",
		// which is why readUpload's "no file" rejection is not an error here.
		if (form.get('logo') instanceof File && (form.get('logo') as File).size > 0) {
			try {
				const upload = await readUpload(form, 'logo', {
					maxBytes: getConfig().maxUploadBytes,
					allowedTypes: LOGO_TYPES
				});

				const key = newStorageKey();
				await getStorage().put(key, upload.bytes);

				const previous = logoStorageKey;
				logoStorageKey = key;
				logoContentType = upload.contentType as Branding['logoContentType'];
				uploaded = true;

				// Only after the replacement is safely stored.
				if (previous) await getStorage().delete(previous);
			} catch (cause) {
				if (cause instanceof UploadRejected) return fail(400, { message: cause.message });
				throw cause;
			}
		}

		let branding: Branding;
		try {
			branding = parseBranding({
				organizationName: String(form.get('organizationName') ?? '').trim(),
				primaryColor: form.get('primaryColor'),
				surfaceColor: form.get('surfaceColor'),
				inkColor: form.get('inkColor'),
				logoStorageKey,
				logoContentType,
				imprintUrl: optionalText(form.get('imprintUrl')),
				privacyUrl: optionalText(form.get('privacyUrl')),
				contactEmail: optionalText(form.get('contactEmail'))
			});
		} catch {
			return fail(400, { message: 'invalid' });
		}

		await setBranding(db, branding);

		// Field names only, never values: contactEmail is personal data, and an
		// audit row can never be corrected once written.
		const changed = (Object.keys(branding) as (keyof Branding)[]).filter(
			(key) => branding[key] !== current[key]
		);

		await recordEvent(db, {
			action: 'settings.branding.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'setting',
			subjectId: 'branding',
			ip: clientIp(event) ?? undefined,
			meta: { changed, logoReplaced: uploaded }
		});

		return { saved: true };
	}
};
