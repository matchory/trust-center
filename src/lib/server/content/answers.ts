import { asc, eq, inArray } from 'drizzle-orm';
import type { AnswerVisibility } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import { answer, answerTranslation } from '../db/schema';

export interface PublicAnswer {
	id: string;
	slug: string;
	question: string;
	answer: string;
	translationLocale: string;
	isTranslationFallback: boolean;
}

export interface PublicAnswerGroup {
	category: string;
	answers: PublicAnswer[];
}

export async function listPublicAnswers(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicAnswerGroup[]> {
	const rows = await db
		.select()
		.from(answer)
		.where(eq(answer.visibility, 'public'))
		.orderBy(asc(answer.category), asc(answer.position), asc(answer.slug));

	if (rows.length === 0) return [];

	const translations = await db
		.select()
		.from(answerTranslation)
		.where(
			inArray(
				answerTranslation.answerId,
				rows.map((row) => row.id)
			)
		);

	const groups: PublicAnswerGroup[] = [];

	for (const row of rows) {
		const mine = translations.filter((item) => item.answerId === row.id);

		const question = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.question })),
			opts.locale,
			opts.defaultLocale
		);
		if (!question) continue;

		const body = pickTranslation(
			mine.map((item) => ({ locale: item.locale, value: item.answer })),
			opts.locale,
			opts.defaultLocale
		);
		if (!body) continue;

		let group = groups.find((candidate) => candidate.category === row.category);
		if (!group) {
			group = { category: row.category, answers: [] };
			groups.push(group);
		}

		group.answers.push({
			id: row.id,
			slug: row.slug,
			question: question.value,
			answer: body.value,
			translationLocale: question.locale,
			isTranslationFallback: question.isFallback
		});
	}

	return groups;
}

export interface AdminAnswer {
	id: string;
	slug: string;
	category: string;
	visibility: AnswerVisibility;
	position: number;
	translations: { locale: string; question: string; answer: string }[];
	questions: Record<string, string>;
}

export async function listAnswersForAdmin(db: Db): Promise<AdminAnswer[]> {
	const rows = await db
		.select()
		.from(answer)
		.orderBy(asc(answer.category), asc(answer.position), asc(answer.slug));
	if (rows.length === 0) return [];

	const translations = await db
		.select()
		.from(answerTranslation)
		.where(
			inArray(
				answerTranslation.answerId,
				rows.map((row) => row.id)
			)
		);

	return rows.map((row) => {
		const mine = translations.filter((item) => item.answerId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			category: row.category,
			visibility: row.visibility as AnswerVisibility,
			position: row.position,
			translations: mine.map((item) => ({
				locale: item.locale,
				question: item.question,
				answer: item.answer
			})),
			questions: Object.fromEntries(mine.map((item) => [item.locale, item.question]))
		};
	});
}

export async function getAnswerForAdmin(db: Db, id: string): Promise<AdminAnswer | null> {
	return (await listAnswersForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createAnswer(
	db: Db,
	input: { slug: string; category: string; visibility?: AnswerVisibility; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(answer)
		.values({
			slug: input.slug,
			category: input.category,
			visibility: input.visibility ?? 'internal',
			position: input.position ?? 0
		})
		.returning({ id: answer.id });

	if (!row) throw new Error('failed to insert answer');
	return row.id;
}

export async function updateAnswer(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		category: string;
		visibility: AnswerVisibility;
		position: number;
	}>
): Promise<void> {
	await db
		.update(answer)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(answer.id, id));
}

export async function deleteAnswer(db: Db, id: string): Promise<void> {
	await db.delete(answer).where(eq(answer.id, id));
}

export async function setAnswerTranslation(
	db: Db,
	answerId: string,
	locale: string,
	values: { question: string; answer: string }
): Promise<void> {
	await db
		.insert(answerTranslation)
		.values({ answerId, locale, ...values })
		.onConflictDoUpdate({
			target: [answerTranslation.answerId, answerTranslation.locale],
			set: values
		});
}
