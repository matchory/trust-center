import { randomUUID } from 'node:crypto';
import {
	accessGrant,
	accessRequest,
	accessRule,
	document,
	documentCategory,
	requester
} from '../../src/lib/server/db/schema';
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

export async function seedRequester(db: Db, input: { email?: string } = {}): Promise<string> {
	const email = input.email ?? `requester-${randomUUID()}@fixture.example`;
	const [row] = await db
		.insert(requester)
		.values({
			email,
			name: 'Fixture Requester',
			company: 'Fixture GmbH',
			companyDomain: email.split('@')[1]!,
			locale: 'de'
		})
		.returning({ id: requester.id });

	return row!.id;
}

/**
 * A live grant: a requester, and an expiry far enough out that a test asserting
 * on scope never trips over the clock.
 */
export async function seedGrant(
	db: Db,
	input: { requesterId?: string; expiresAt?: Date; termDays?: number } = {}
): Promise<string> {
	const requesterId = input.requesterId ?? (await seedRequester(db));
	const [row] = await db
		.insert(accessGrant)
		.values({
			requesterId,
			requestId: null,
			termDays: input.termDays ?? 30,
			expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		})
		.returning({ id: accessGrant.id });

	return row!.id;
}

/**
 * A verified request. `unverified` is deliberately not the default shape:
 * `access_request_verification_check` makes the two states mutually exclusive,
 * so a request carrying a requester is the one a scope set can hang off.
 */
export async function seedRequest(
	db: Db,
	input: { requesterId?: string; status?: string } = {}
): Promise<string> {
	const requesterId = input.requesterId ?? (await seedRequester(db));
	const [row] = await db
		.insert(accessRequest)
		.values({ requesterId, status: input.status ?? 'pending' })
		.returning({ id: accessRequest.id });

	return row!.id;
}

export async function seedRule(
	db: Db,
	input: { pattern: string; action?: string; priority?: number }
): Promise<string> {
	const [row] = await db
		.insert(accessRule)
		.values({
			pattern: input.pattern,
			action: input.action ?? 'auto_approve',
			priority: input.priority ?? 100
		})
		.returning({ id: accessRule.id });

	return row!.id;
}
