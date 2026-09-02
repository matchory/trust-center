import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { ANSWER_VISIBILITIES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationsAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import {
	deleteAnswer,
	getAnswerForAdmin,
	setAnswerTranslation,
	updateAnswer
} from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getAnswerForAdmin(getDb(), params.id);
	if (!item) error(404, 'Answer not found');
	return { answer: item };
};

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'answer',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			category: z.string().trim().min(1),
			visibility: z.enum(ANSWER_VISIBILITIES),
			position: z.coerce.number().int()
		}),
		read: (form) => ({
			slug: form.get('slug'),
			category: form.get('category'),
			visibility: form.get('visibility'),
			position: form.get('position') ?? 0
		}),
		update: (db, id, data) => updateAnswer(db, id, data),
		isPublished: (data) => data.visibility === 'public',
		fallbackField: 'slug'
	}),

	saveTranslations: saveTranslationsAction({
		type: 'answer',
		required: ['question', 'answer'],
		set: (db, id, locale, values) =>
			setAnswerTranslation(db, id, locale, {
				question: values.question!,
				answer: values.answer!
			})
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteAnswer(db, event.params.id);

		await recordEvent(db, {
			action: 'answer.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'answer',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/faq', event.locals.locale));
	}
};
