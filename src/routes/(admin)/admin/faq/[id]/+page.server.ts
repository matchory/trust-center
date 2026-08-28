import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { ANSWER_VISIBILITIES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteAnswer,
	getAnswerForAdmin,
	setAnswerTranslation,
	updateAnswer
} from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getAnswerForAdmin(getDb(), params.id);
	if (!item) error(404, 'Answer not found');
	return { answer: item };
};

/** One shape for every action failure, so the form can narrow on `field` alone. */
type AnswerActionFailure = { field: string; locale?: string };

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				category: z.string().trim().min(1),
				visibility: z.enum(ANSWER_VISIBILITIES),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				category: form.get('category'),
				visibility: form.get('visibility'),
				position: form.get('position') ?? 0
			});
		if (!parsed.success) {
			return fail<AnswerActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'slug')
			});
		}

		const db = getDb();
		await updateAnswer(db, params.id, parsed.data);

		await recordEvent(db, {
			// Becoming public is its own event: "when did this answer become
			// visible to anyone who asks" is a question worth answering directly.
			action: parsed.data.visibility === 'public' ? 'answer.published' : 'answer.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'answer',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: parsed.data
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale') ?? '');
		if (!getConfig().locales.includes(locale)) {
			return fail<AnswerActionFailure>(400, { field: 'locale' });
		}

		const question = String(form.get('question') ?? '').trim();
		const body = String(form.get('answer') ?? '').trim();
		if (!question) return fail<AnswerActionFailure>(400, { field: 'question', locale });
		if (!body) return fail<AnswerActionFailure>(400, { field: 'answer', locale });

		const db = getDb();
		await setAnswerTranslation(db, params.id, locale, { question, answer: body });

		await recordEvent(db, {
			action: 'answer.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'answer',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteAnswer(db, params.id);

		await recordEvent(db, {
			action: 'answer.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'answer',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/faq', locals.locale));
	}
};
