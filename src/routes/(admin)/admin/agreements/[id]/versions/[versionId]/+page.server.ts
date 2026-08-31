import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { parseAgreementBody, MarkdownNotInSubset } from '$lib/markdown/subset';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { ndaTemplateBody, ndaTemplateVersion } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import {
	getTemplate,
	publishVersion,
	setVersionBody,
	VersionImmutable,
	VersionIncomplete
} from '$lib/server/nda/templates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const template = await getTemplate(db, params.id, getConfig().locales);
	if (!template) error(404, 'Agreement not found');

	const version = template.versions.find((entry) => entry.id === params.versionId);
	if (!version) error(404, 'Version not found');

	const rows = await db
		.select()
		.from(ndaTemplateBody)
		.where(eq(ndaTemplateBody.versionId, params.versionId));

	// Parsed on the server and shipped as an AST, so the preview and the
	// click-through are the same tree and not two parsers that agree today.
	const bodies = Object.fromEntries(
		rows.map((row) => [row.locale, { bodyMd: row.bodyMd, root: parseAgreementBody(row.bodyMd) }])
	);

	return { template, version, bodies, locales: getConfig().locales };
};

type VersionFailure = { field: string; message?: string };

export const actions: Actions = {
	saveBody: async (event) => {
		const db = getDb();
		const form = await event.request.formData();

		const submitted = getConfig()
			.locales.map((locale) => ({
				locale,
				body: String(form.get(`body.${locale}`) ?? '').trim()
			}))
			.filter((entry) => entry.body.length > 0);

		// Validated in memory before anything is written: `setVersionBody` opens
		// its own transaction per locale, so a bad body in the second locale
		// must not leave the first locale's — already-written — body sitting in
		// the database with no audit event for it.
		try {
			for (const entry of submitted) parseAgreementBody(entry.body);
		} catch (cause) {
			if (cause instanceof MarkdownNotInSubset) {
				return fail<VersionFailure>(400, { field: 'body', message: cause.nodeType });
			}
			throw cause;
		}

		const written: string[] = [];

		try {
			for (const entry of submitted) {
				await setVersionBody(db, event.params.versionId, entry.locale, entry.body);
				written.push(entry.locale);
			}
		} catch (cause) {
			if (cause instanceof VersionImmutable) {
				return fail<VersionFailure>(409, { field: 'body', message: 'immutable' });
			}
			throw cause;
		}

		await recordEvent(db, {
			action: 'nda_template_version.updated',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template_version',
			subjectId: event.params.versionId,
			ip: clientIp(event) ?? undefined,
			meta: { locales: written }
		});

		return { saved: true };
	},

	publish: async (event) => {
		const db = getDb();

		// `publishVersion` has no guard of its own against a version that is
		// already effective — a second call would only bump `effective_from` to
		// a later timestamp and could reorder `effectiveVersion`'s
		// desc(effectiveFrom) precedence. The route refuses it before calling in.
		const [existing] = await db
			.select({ effectiveFrom: ndaTemplateVersion.effectiveFrom })
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.id, event.params.versionId))
			.limit(1);

		if (existing?.effectiveFrom) {
			return fail<VersionFailure>(409, { field: 'publish', message: 'already-published' });
		}

		try {
			await publishVersion(db, event.params.versionId, getConfig().locales);
		} catch (cause) {
			if (cause instanceof VersionIncomplete) {
				return fail<VersionFailure>(409, { field: 'publish', message: 'incomplete' });
			}
			throw cause;
		}

		await recordEvent(db, {
			action: 'nda_template_version.published',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'nda_template_version',
			subjectId: event.params.versionId,
			ip: clientIp(event) ?? undefined,
			meta: {}
		});

		return { saved: true };
	}
};
