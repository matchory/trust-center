import { document, documentCategory } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/db';

export async function seedDocument(
	db: Db,
	input: { slug: string; tier: 'public' | 'request' | 'nda'; status?: 'draft' | 'published' }
): Promise<string> {
	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${input.slug}`, position: 0 })
		.returning({ id: documentCategory.id });

	const [row] = await db
		.insert(document)
		.values({
			slug: input.slug,
			categoryId: category!.id,
			tier: input.tier,
			status: input.status ?? 'published'
		})
		.returning({ id: document.id });

	return row!.id;
}
