import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRule,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	requester
} from '../../src/lib/server/db/schema';
import {
	outstandingAgreements,
	recordAcceptance,
	validAcceptance,
	VersionMoved
} from '../../src/lib/server/nda/acceptance';
import { renderRecord, storeRecord } from '../../src/lib/server/nda/record';
import { recordRequirements } from '../../src/lib/server/nda/requirements';
import {
	createVersion,
	publishVersion,
	setVersionBody,
	VersionImmutable
} from '../../src/lib/server/nda/templates';
import { createLocalStorage } from '../../src/lib/server/storage/local';
import { drawnText } from '../helpers/pdf';
import {
	seedAgreement,
	seedGrant,
	seedInertGrant,
	seedRequester,
	seedRule,
	seedStaff
} from '../setup/fixtures';

const LOCALES = ['de', 'en'];

let db: Db;
let close: () => Promise<void>;

let templateId: string;
let versionId: string;
let bodySha: string;
let requesterId: string;
let requesterEmail: string;
let colleagueId: string;
let strangerId: string;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

// Children before parents: `nda_acceptance.version_id` is ON DELETE RESTRICT,
// so an acceptance left behind here makes every later file's version cleanup
// fail.
afterAll(async () => {
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await db.delete(accessRule);
	await db.delete(requester);
	await close();
});

beforeEach(async () => {
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await db.delete(accessRule);
	await db.delete(requester);

	({
		templateId,
		versionId,
		sha256: bodySha
	} = await seedAgreement(db, {
		slug: `mutual-${randomUUID().slice(0, 8)}`,
		locales: LOCALES
	}));

	requesterEmail = `signatory-${randomUUID()}@fixture.example`;
	requesterId = await seedRequester(db, { email: requesterEmail });
	colleagueId = await seedRequester(db, {
		email: `colleague-${randomUUID()}@fixture.example`
	});
	strangerId = await seedRequester(db, { email: `stranger-${randomUUID()}@gmail.com` });
});

describe('recording an acceptance', () => {
	it('pins the exact bytes the signatory saw', async () => {
		const { acceptanceId } = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'Šimon Čech',
			sha256: bodySha,
			ip: '203.0.113.9',
			ua: 'test',
			locales: LOCALES
		});

		const [row] = await db.select().from(ndaAcceptance).where(eq(ndaAcceptance.id, acceptanceId));
		expect(row?.templateSha256).toBe(bodySha);
		// Denormalized at acceptance time so the record survives a purge intact.
		expect(row?.email).toBe(requesterEmail);
		expect(row?.companyDomain).toBe('fixture.example');
	});

	it('writes nothing when the version moved between render and POST', async () => {
		// Without this, a version published while somebody is reading produces a
		// record whose template_sha256 pins bytes the signatory demonstrably never
		// saw — a hash that lies with the full authority of the record. The
		// (requester_id, version_id) constraint gives no protection: it is a
		// different version and inserts cleanly.
		const stale = await createVersion(db, templateId);

		await expect(
			recordAcceptance(db, {
				requesterId,
				versionId: stale.versionId,
				typedName: 'A Person',
				sha256: bodySha,
				ip: null,
				ua: null,
				locales: LOCALES
			})
		).rejects.toBeInstanceOf(VersionMoved);

		expect(await db.select().from(ndaAcceptance)).toHaveLength(0);
	});

	it('treats a double submit as already accepted', async () => {
		const first = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});
		const second = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(second.acceptanceId).toBe(first.acceptanceId);
		expect(second.created).toBe(false);
	});

	it('stamps first_accepted_at, freezing the version', async () => {
		await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		const [version] = await db
			.select()
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.id, versionId));
		expect(version?.firstAcceptedAt).not.toBeNull();
		await expect(setVersionBody(db, versionId, 'de', '# Anders')).rejects.toBeInstanceOf(
			VersionImmutable
		);
	});
});

describe('whose acceptance covers whom', () => {
	it('does not let one colleague cover another under person scope', async () => {
		await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(
			await validAcceptance(db, {
				requesterId: colleagueId,
				companyDomain: 'fixture.example',
				templateId,
				scope: 'person',
				locales: LOCALES
			})
		).toBeNull();
	});

	it('lets a colleague cover another under domain scope, but only for a rule-matched domain', async () => {
		await seedRule(db, {
			pattern: 'fixture.example',
			action: 'auto_approve',
			tiers: ['request']
		});
		await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(
			await validAcceptance(db, {
				requesterId: colleagueId,
				companyDomain: 'fixture.example',
				templateId,
				scope: 'domain',
				locales: LOCALES
			})
		).not.toBeNull();

		// Nothing in the schema distinguishes a corporate domain from gmail.com,
		// and `decideFromRules` returns `review` for an unmatched domain rather
		// than denying it. Without this bound, one hand-approved free-mail
		// requester satisfies the requirement for an unbounded population.
		expect(
			await validAcceptance(db, {
				requesterId: strangerId,
				companyDomain: 'gmail.com',
				templateId,
				scope: 'domain',
				locales: LOCALES
			})
		).toBeNull();
	});

	it('finds the signatory their own acceptance under person scope', async () => {
		const { acceptanceId } = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(
			await validAcceptance(db, {
				requesterId,
				companyDomain: 'fixture.example',
				templateId,
				scope: 'person',
				locales: LOCALES
			})
		).toMatchObject({ acceptanceId, versionId });
	});

	it('stops counting an acceptance of a superseded version', async () => {
		// §6.2: a new effective version is a new agreement. An acceptance of the
		// old one is still a true record of what that person signed, and is still
		// not an acceptance of what the document now requires.
		await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		const { versionId: next } = await createVersion(db, templateId);
		for (const locale of LOCALES) await setVersionBody(db, next, locale, '# Zwei');
		await publishVersion(db, next, LOCALES);

		expect(
			await validAcceptance(db, {
				requesterId,
				companyDomain: 'fixture.example',
				templateId,
				scope: 'person',
				locales: LOCALES
			})
		).toBeNull();
	});
});

describe('what a requester still owes', () => {
	const options = { locales: LOCALES, locale: 'de', scope: 'person' as const };

	it('lists an agreement a grant of theirs requires', async () => {
		await seedInertGrant(db, { requesterId, requires: [templateId] });

		expect(await outstandingAgreements(db, requesterId, options)).toMatchObject([{ templateId }]);
	});

	it('lists nothing once they have accepted it', async () => {
		await seedInertGrant(db, { requesterId, requires: [templateId] });
		await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(await outstandingAgreements(db, requesterId, options)).toEqual([]);
	});

	it('lists nothing for a waived requirement', async () => {
		// The disposition filter is the whole of the bypass, which is why §7.3
		// needs the waiver recorded as a row rather than omitted.
		const grantId = await seedGrant(db, { requesterId });
		await recordRequirements(
			db,
			grantId,
			[{ templateId, disposition: 'waived', reason: 'on paper' }],
			await seedStaff(db),
			{ locales: LOCALES }
		);

		expect(await outstandingAgreements(db, requesterId, options)).toEqual([]);
	});
});

describe('the acceptance record', () => {
	const FONT_DIR = './assets/fonts';

	it('renders a record naming the counterparty, the version and the hash', async () => {
		const bytes = await renderRecord({
			fontDir: FONT_DIR,
			title: 'Mutual NDA',
			version: 3,
			bodyMd: '# Mutual NDA\n\nYou agree to **keep it quiet**.',
			typedName: 'Łukasz Nowak',
			email: 'lukasz@acme.example',
			company: 'Acme GmbH',
			acceptedAt: new Date('2026-06-01T09:30:00Z'),
			ip: '203.0.113.9',
			sha256: 'a'.repeat(64),
			locale: 'en'
		});

		const drawn = await drawnText(bytes);
		expect(drawn).toContain('Łukasz Nowak');
		expect(drawn).toContain('keep it quiet');
		expect(drawn).toContain('a'.repeat(64));
		// The metadata is what makes the signature enforceable (§10.2).
		expect(drawn).toContain('203.0.113.9');
	});

	it('records the stored key on the acceptance', async () => {
		const storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'nda-record-')));
		const { acceptanceId } = await recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'Łukasz Nowak',
			sha256: bodySha,
			ip: '203.0.113.9',
			ua: 'test',
			locales: LOCALES
		});

		const bytes = await renderRecord({
			fontDir: FONT_DIR,
			title: 'Mutual NDA',
			version: 1,
			bodyMd: '# Mutual NDA\n\nBody.',
			typedName: 'Łukasz Nowak',
			email: requesterEmail,
			company: 'Acme GmbH',
			acceptedAt: new Date(),
			ip: '203.0.113.9',
			sha256: bodySha,
			locale: 'en'
		});
		await storeRecord(db, storage, acceptanceId, bytes);

		const [row] = await db.select().from(ndaAcceptance).where(eq(ndaAcceptance.id, acceptanceId));
		expect(row?.recordPdfKey).toMatch(/\S/);
		expect(await storage.stat(row!.recordPdfKey!)).not.toBeNull();
	});
});
