import { randomUUID } from 'node:crypto';
import {
	accessGrant,
	accessGrantNda,
	accessRequest,
	accessRule,
	document,
	documentCategory,
	requester
} from '../../src/lib/server/db/schema';
import { setRuleTiers } from '../../src/lib/server/access/scope';
import {
	createTemplate,
	createVersion,
	publishVersion,
	setVersionBody
} from '../../src/lib/server/nda/templates';
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
 * A live grant by default: a requester, and an expiry far enough out that a
 * test asserting on scope never trips over the clock. Pass `expiresAt: null`
 * (with an `acceptanceDueAt`) to seed an inert grant instead, without
 * hand-rolling one.
 */
export async function seedGrant(
	db: Db,
	input: {
		requesterId?: string;
		expiresAt?: Date | null;
		termDays?: number;
		acceptanceDueAt?: Date | null;
	} = {}
): Promise<string> {
	const requesterId = input.requesterId ?? (await seedRequester(db));
	const [row] = await db
		.insert(accessGrant)
		.values({
			requesterId,
			requestId: null,
			termDays: input.termDays ?? 30,
			expiresAt:
				'expiresAt' in input ? input.expiresAt : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			acceptanceDueAt: input.acceptanceDueAt ?? null
		})
		.returning({ id: accessGrant.id });

	return row!.id;
}

/**
 * A grant waiting on an acceptance: no expiry, a deadline, and its frozen
 * requirement set. The pairing is what `access_grant_inert_check` enforces, so
 * building one by hand is how a test comes to describe a grant the database
 * would refuse.
 */
export async function seedInertGrant(
	db: Db,
	input: { requesterId: string; requires: readonly string[]; dueInDays?: number }
): Promise<string> {
	const [row] = await db
		.insert(accessGrant)
		.values({
			requesterId: input.requesterId,
			termDays: 30,
			expiresAt: null,
			acceptanceDueAt: new Date(Date.now() + (input.dueInDays ?? 14) * 86_400_000)
		})
		.returning({ id: accessGrant.id });

	for (const ndaTemplateId of input.requires) {
		await db.insert(accessGrantNda).values({
			grantId: row!.id,
			ndaTemplateId,
			disposition: 'required'
		});
	}

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

/**
 * A rule and the tier set that scopes it. The two are one fact — a rule with no
 * tiers auto-approves no blanket — so seeding them apart is how a fixture comes
 * to describe a rule an operator could not have created.
 */
export async function seedRule(
	db: Db,
	input: { pattern: string; action?: string; priority?: number; tiers?: readonly string[] }
): Promise<string> {
	const [row] = await db
		.insert(accessRule)
		.values({
			pattern: input.pattern,
			action: input.action ?? 'auto_approve',
			priority: input.priority ?? 100
		})
		.returning({ id: accessRule.id });

	if (input.tiers) await setRuleTiers(db, row!.id, input.tiers);

	return row!.id;
}

/**
 * A template with one published, locale-complete version — the shape every
 * later task's tests need and the only one a requester can ever be asked to
 * sign. Returns the hash so a test can pin what the form rendered.
 */
export async function seedAgreement(
	db: Db,
	input: { slug: string; locales: readonly string[] }
): Promise<{ templateId: string; versionId: string; sha256: string }> {
	const templateId = await createTemplate(db, { slug: input.slug });
	const { versionId } = await createVersion(db, templateId);

	let sha256 = '';
	for (const locale of input.locales) {
		({ sha256 } = await setVersionBody(db, versionId, locale, `# ${input.slug}\n\nBody.`));
	}

	await publishVersion(db, versionId, input.locales);
	return { templateId, versionId, sha256 };
}
