# Phase 3c — Authoring Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author an agreement body by importing a PDF or DOCX into the canonical Markdown subset and editing it in a WYSIWYG editor, and clear the three carry-over items 3b measured and left standing.

**Architecture:** Import is a read-only extraction that hands Markdown back to the editor and never writes; `?/saveBody` stays the only writer, so this phase mints no audit action name. PDF and DOCX extraction each produce mdast, which is stringified through `remark-stringify` — that is also what mechanically enforces P3.21, because a paragraph beginning `1.` stringifies as `1\.` and re-parses as text rather than as a list. Milkdown replaces the per-locale textarea while the server-rendered `AgreementBody` preview stays beside it. Two themes with no relation to the NDA workflow ride along: the six single-locale editors move onto the multi-locale form shape, and three read-path costs collapse into one join.

**Tech Stack:** SvelteKit (Svelte 5 runes) · Drizzle + postgres-js · unified/remark/rehype · `pdfjs-dist` · `mammoth` · `@milkdown/*` · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-08-30-phase-3-nda-workflow-design.md`, as amended by §20. Read §3, §5.1, §5.4, §5.5, §11 (P3.21–P3.24), §13, §14, §16 and §20 before starting.

## Global Constraints

Every task's requirements implicitly include this section.

- **No schema changes and no migrations.** §3: "**No schema changes.**" If a task appears to need one, stop and escalate — it means the task was misread.
- **No new audit action names.** Names are permanent once written (§11 P3.22, and `translationAction`'s comment in `src/lib/server/admin/actions.ts`). This phase records only `nda_template_version.updated`, `nda_template_version.published`, and the existing `<type>.translation.updated` from `translationAction`.
- **`pdfjs-dist`, `mammoth` and `@milkdown/*` are admin-only** (§10.4). Milkdown is loaded through a dynamic `import()` inside `onMount`; the extraction libraries are imported only from `src/lib/server/**`. No public route may pull any of them.
- **The public portal still sets no cookies and makes no third-party requests.** `tests/e2e/security.spec.ts` asserts this permanently; do not weaken it.
- **`vite build` must succeed with `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `SMTP_URL` unset.** Importing a module must never open a connection.
- **`pnpm check` ends at 0 errors, 0 warnings.** That is the state 3b closed in and the bar this phase is held to.
- **Formatting:** tabs, single quotes, no trailing commas, 100-column print width (`.prettierrc`). Run `pnpm format` before every commit and `pnpm lint` before every gate.
- **Comments record why, naming the failure mode or the spec section.** Match the surrounding density; do not restate the code.
- **Requester personal data appears in `audit_event` only in `ip`, `ua` and `actor_id`** — never in `meta`, never in `subject_id`.

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `src/lib/markdown/downgrade.ts` | Pure mdast → mdast pass mapping nodes outside §5.1's subset onto their nearest subset equivalent, reporting what it changed. No heavy dependencies, so it unit-tests without a database or a browser. |
| `src/lib/server/nda/import/pdf.ts` | `pdfjs-dist` text extraction → lines → paragraphs and headings → Markdown. Owns `PdfHasNoText`. |
| `src/lib/server/nda/import/docx.ts` | `mammoth` → HTML → mdast → downgrade → Markdown. |
| `src/lib/server/nda/import/index.ts` | One entry point dispatching on content type; the only thing routes import. |
| `src/lib/components/admin/MarkdownEditor.svelte` | Milkdown wrapper writing through to a hidden textarea, so the POST shape is unchanged. |
| `tests/unit/agreement-import.test.ts` | The downgrade pass, the PDF grouper, `PdfHasNoText`, and the P3.21 enumerator case. |
| `tests/helpers/docx.ts` | Builds a minimal but valid DOCX as a stored ZIP, so import tests do not carry a binary fixture in the repo. |

**Modified**

| Path | Change |
| --- | --- |
| `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.server.ts` | Adds the `?/import` action. Writes nothing. |
| `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.svelte` | Per-locale import control and dropped-node notice; textarea becomes `MarkdownEditor`. |
| `src/lib/components/admin/LocaleTabs.svelte` | Keeps every pane mounted and hides the inactive ones. |
| `src/lib/server/admin/actions.ts` | Gains `saveTranslationsAction` (plural); loses `saveTranslationAction` (singular) at the end of the theme. |
| Six admin editors under `src/routes/(admin)/admin/{faq,subprocessors,updates,controls,certifications,documents}/[id]/` | Move from one POST per locale to one multi-locale form. |
| `src/lib/server/access/grants.ts` | Folds tier and group agreements into the conferred select; `countGrantDocuments` aggregates again when nothing is gated. |
| `src/lib/server/nda/templates.ts` | `effectiveVersion` tests locale completeness on `(versionId, locale)` and fetches bodies only for the winner. |
| `tests/e2e/request.spec.ts`, `tests/e2e/access-journey.spec.ts`, `tests/helpers/admin.ts` | Stop clearing the one rate-limit bucket a test depends on. |
| `tests/helpers/pdf.ts` | Gains `textPdf` beside the existing `blankPdf` and `drawnText`; `blankPdf` is the scan fixture, so no `emptyPdf` is written. |

## Theme order and gates

Task 1 first, alone: a suite that fails intermittently cannot gate anything that follows it, and every gate below is a full-suite run.

Then the four themes of §3, in order, with a gate after each: **import** (Tasks 2–8), **editor** (Tasks 9–11), **translation-shape consolidation** (Tasks 12–20), **read path** (Tasks 21–24). At each gate run `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. A theme that runs long is dropped whole and recorded in the carry-over; the consolidation is the first candidate, because nothing depends on it.

---

### Task 1: Stop the specs from clearing the bucket the flood case depends on

`request.spec.ts`'s flood case passes alone and fails intermittently in a full run. The submission route runs two limiters — `request:email` and `request:ip`, five per hour each. Every spec in a run shares one client address, so several specs call `db.delete(rateLimit)` to avoid being throttled themselves, and a delete landing mid-flood resets the counter under the test.

The fix is in the fixture, not the limiter. Keys are `<scope>:<hash>`, so the address buckets are exactly the keys matching `%:ip:%` and the email buckets are `request:email:%`. Specs keep clearing every address bucket, and the one bucket the flood case owns is never touched — which requires the flood case to flood **one email** rather than one address. The address limiter keeps its own coverage in `tests/integration/ratelimit.test.ts`; what the e2e case is really for is that the form renders the throttled state.

That is necessary and, as Gate 2 showed, not sufficient. Clearing the address buckets once in `beforeEach` still leaves the flood case racing every other worker: specs run in parallel, they submit from the same client address, and a concurrent submission can eat the five-per-hour allowance before the loop reaches its fifth — which fails as a confirmation that never appears, not as a limiter that refused. The flood case has to clear the address buckets **before every one of its submissions**, the sixth included; then the email bucket is the only limiter that can trip, and the refusal it asserts cannot have come from anywhere else.

**Files:**
- Modify: `tests/e2e/request.spec.ts:38`, `tests/e2e/request.spec.ts:170-179`
- Modify: `tests/e2e/access-journey.spec.ts:99`
- Modify: `tests/helpers/admin.ts:177`

**Interfaces:**
- Consumes: `rateLimit` from `src/lib/server/db/schema`, `not` and `like` from `drizzle-orm`.
- Produces: nothing other tasks depend on.

- [x] **Step 1: Confirm the failure is the one described**

Run the flood case alone, then the whole file, three times each:

```sh
pnpm test:e2e tests/e2e/request.spec.ts --project=app -t 'flood' --repeat-each=3
pnpm test:e2e --project=app --repeat-each=3
```

Expected: the first passes every time; the second fails the flood case at least once. If the full run passes three times, do not skip the task — the hazard is real and documented in the 3c carry-over; note in the commit that the failure did not reproduce today.

- [x] **Step 2: Narrow the three wholesale deletes**

In each of the three files, replace `await db.delete(rateLimit);` with a delete that spares the email buckets:

```ts
// Every address bucket, and nothing else. A full run submits far more than the
// five-per-hour the address limiter allows, so specs must clear it. The email
// buckets are spared because the flood case below asserts one of them, and a
// delete landing mid-flood is what made that case fail only in full runs.
await db.delete(rateLimit).where(not(like(rateLimit.key, 'request:email:%')));
```

Add `import { like, not } from 'drizzle-orm';` to each file, merging with the existing `drizzle-orm` import where there is one.

- [x] **Step 3: Point the flood case at the email limiter**

In `tests/e2e/request.spec.ts`, replace the flood case body so all six submissions carry the same address:

```ts
test('the submission limiter refuses a flood to one address', async ({ page }) => {
	// One email, six times: the *email* limiter is what this asserts. It used to
	// flood six different emails against the address limiter, whose bucket every
	// spec in the run shares and several reset — see the fixture above. The
	// address limiter keeps its coverage in tests/integration/ratelimit.test.ts.
	const email = `e2e-flood-${Date.now()}@acme.example`;

	for (let i = 0; i < 5; i++) {
		await fillAndSubmit(page, email);
	}

	await fillAndSubmit(page, email);
	await expect(page.getByTestId('request-throttled')).toBeVisible();
});
```

Read the existing case first and keep its assertion helper and testid exactly as they are — only the emails and the comment change. If the existing case asserts something other than `request-throttled`, keep that assertion.

- [x] **Step 4: Verify, repeatedly**

```sh
pnpm test:e2e --project=app --repeat-each=3
```

Expected: PASS on all three runs. This is the only step that proves the fix; a single green run does not.

- [x] **Step 5: Commit**

```sh
pnpm format
git add tests/e2e/request.spec.ts tests/e2e/access-journey.spec.ts tests/helpers/admin.ts
git commit -m "test(e2e): stop clearing the bucket the flood case asserts"
```

---

### Task 2: The downgrade pass

A real contract in DOCX carries nodes §5.1 forbids. Refusing the document for containing one table would make import useless on its intended input, so conversion ends by mapping those nodes onto their nearest subset equivalent and naming what it changed (P3.23).

Pure mdast in, mdast out — no database, no browser, no `mammoth`. It lives beside `subset.ts` because it is the same subject and the same dependency footprint.

**Files:**
- Create: `src/lib/markdown/downgrade.ts`
- Test: `tests/unit/agreement-import.test.ts`

**Interfaces:**
- Consumes: `SUBSET_NODE_TYPES` from `src/lib/markdown/subset.ts`; `Root`, `RootContent` from `mdast`.
- Produces: `downgradeToSubset(root: Root): { root: Root; dropped: string[] }` — `dropped` is the sorted, de-duplicated list of node types that were removed or rewritten.

- [x] **Step 1: Write the failing tests**

Create `tests/unit/agreement-import.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root } from 'mdast';
import { downgradeToSubset } from '../../src/lib/markdown/downgrade';
import { SUBSET_NODE_TYPES } from '../../src/lib/markdown/subset';

const parse = (markdown: string): Root => unified().use(remarkParse).parse(markdown) as Root;

describe('downgradeToSubset', () => {
	it('keeps a body that is already in the subset untouched', () => {
		const { root, dropped } = downgradeToSubset(parse('# Title\n\nA paragraph.'));

		expect(dropped).toEqual([]);
		expect(root.children.map((node) => node.type)).toEqual(['heading', 'paragraph']);
	});

	it('unwraps a link to its text and reports it', () => {
		const { root, dropped } = downgradeToSubset(parse('See [our policy](https://x.test).'));

		expect(dropped).toEqual(['link']);
		expect(JSON.stringify(root)).toContain('our policy');
		expect(JSON.stringify(root)).not.toContain('https://x.test');
	});

	it('drops an image entirely', () => {
		const { root, dropped } = downgradeToSubset(parse('![logo](https://x.test/l.png)'));

		expect(dropped).toEqual(['image']);
		expect(JSON.stringify(root)).not.toContain('x.test');
	});

	it('hoists a blockquote and reports it', () => {
		const { root, dropped } = downgradeToSubset(parse('> Quoted text.'));

		expect(dropped).toEqual(['blockquote']);
		expect(root.children.map((node) => node.type)).toEqual(['paragraph']);
	});

	it('turns code into a paragraph carrying its literal text', () => {
		const { root, dropped } = downgradeToSubset(parse('```\nliteral\n```'));

		expect(dropped).toEqual(['code']);
		expect(JSON.stringify(root)).toContain('literal');
	});

	it('reports each changed type once, sorted', () => {
		const { dropped } = downgradeToSubset(
			parse('![a](https://x.test/a.png)\n\n![b](https://x.test/b.png)\n\n> q')
		);

		expect(dropped).toEqual(['blockquote', 'image']);
	});

	it('leaves no node type outside the subset anywhere in the tree', () => {
		const { root } = downgradeToSubset(
			parse('# T\n\n> [link](https://x.test) and `code`\n\n![i](https://x.test/i.png)')
		);

		const types: string[] = [];
		const walk = (node: { type: string; children?: unknown[] }): void => {
			types.push(node.type);
			for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
				walk(child);
			}
		};
		walk(root);

		expect(types.filter((type) => !SUBSET_NODE_TYPES.includes(type as never))).toEqual([]);
	});
});
```

- [x] **Step 2: Run them to verify they fail**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/lib/markdown/downgrade"`.

- [x] **Step 3: Write the downgrade pass**

Create `src/lib/markdown/downgrade.ts`:

```ts
import type { Root, RootContent } from 'mdast';
import { SUBSET_NODE_TYPES } from './subset';

const ALLOWED = new Set<string>(SUBSET_NODE_TYPES);

/**
 * §5.1's subset is what an agreement body may contain, and `parseAgreementBody`
 * refuses everything else. That refusal is right for a body somebody typed and
 * wrong for one converted out of a contract: a real DOCX carries links, images
 * and tables, and rejecting the document because of one table would make import
 * useless on exactly its intended input (P3.23).
 *
 * So conversion ends here, mapping each unsupported node onto the nearest thing
 * the subset can express, and naming what it changed so the author is told at
 * the moment they can still fix it. After this pass a `MarkdownNotInSubset` is
 * a bug in this file, not an expected rejection.
 */
export interface Downgraded {
	root: Root;
	/** Node types removed or rewritten, de-duplicated and sorted. */
	dropped: string[];
}

export function downgradeToSubset(root: Root): Downgraded {
	const dropped = new Set<string>();
	const children = rewriteAll(root.children, dropped);

	return {
		root: { type: 'root', children },
		dropped: [...dropped].sort()
	};
}

function rewriteAll(nodes: RootContent[], dropped: Set<string>): RootContent[] {
	return nodes.flatMap((node) => rewrite(node, dropped));
}

/**
 * Returns zero or more replacement nodes. Zero is a deletion; more than one is
 * a hoist — a blockquote's children take its place rather than its content
 * being lost with it.
 */
function rewrite(node: RootContent, dropped: Set<string>): RootContent[] {
	if (ALLOWED.has(node.type)) {
		if ('children' in node && Array.isArray(node.children)) {
			return [{ ...node, children: rewriteAll(node.children as RootContent[], dropped) }];
		}
		return [node];
	}

	dropped.add(node.type);

	switch (node.type) {
		// The text survives, the destination does not: a URL in a signed
		// agreement is a term nobody agreed to, and the subset cannot render it.
		case 'link':
		case 'linkReference':
			return rewriteAll(node.children as RootContent[], dropped);

		// A quote is a paragraph with an indent we cannot express; its contents
		// are the part that matters.
		case 'blockquote':
			return rewriteAll(node.children as RootContent[], dropped);

		// Literal text, kept as text. `value` rather than children: these are
		// leaves.
		case 'code':
		case 'inlineCode':
			return [{ type: 'paragraph', children: [{ type: 'text', value: node.value }] }];

		// One paragraph per row, cells joined — a table's information is the row,
		// and a row read aloud is a sentence.
		case 'table':
			return (node.children as RootContent[]).flatMap((row) => rewriteRow(row, dropped));

		// Images, raw HTML, footnotes and anything else a parser can produce
		// carry nothing the subset can show.
		default:
			return [];
	}
}

function rewriteRow(row: RootContent, dropped: Set<string>): RootContent[] {
	if (!('children' in row) || !Array.isArray(row.children)) return [];

	const cells = (row.children as RootContent[])
		.map((cell) => textOf(cell, dropped).trim())
		.filter((text) => text.length > 0);

	if (cells.length === 0) return [];
	return [{ type: 'paragraph', children: [{ type: 'text', value: cells.join(' — ') }] }];
}

function textOf(node: RootContent, dropped: Set<string>): string {
	if ('value' in node && typeof node.value === 'string') return node.value;
	if (!('children' in node) || !Array.isArray(node.children)) return '';
	return (node.children as RootContent[]).map((child) => textOf(child, dropped)).join('');
}
```

- [x] **Step 4: Run the tests to verify they pass**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```sh
pnpm format
git add src/lib/markdown/downgrade.ts tests/unit/agreement-import.test.ts
git commit -m "feat(markdown): map a converted body onto the subset, naming what changed"
```

---

### Task 3: Fixtures for a PDF that carries text and a DOCX

The import tests need real files. Committing binaries would make them unreadable and unmaintainable, so both are built in code: the PDF with `pdf-lib`, which the repo already uses for fixtures, and the DOCX as a stored (uncompressed) ZIP, which is fifty lines and needs no new dependency — Node 22 ships `zlib.crc32`, and the repo already requires Node 22+.

Two corrections to what this task first said, both from reading `tests/helpers/` before writing anything:

- **There is no `emptyPdf` to write.** `tests/helpers/pdf.ts` already exports `blankPdf(pages = 1)` — a loadable PDF with pages and no text, which is exactly what a scan looks like to an extractor. A second name for the same fixture is a second thing to keep true.
- **The builders go beside their subjects, not into a `fixtures.ts`.** `tests/helpers/pdf.ts` is already where PDF fixtures live (`blankPdf`, `drawnText`), so `textPdf` joins them; the DOCX builder is the genuinely new thing and gets `tests/helpers/docx.ts`. A file named for the word "fixtures" says nothing about what is in it, and this repo sorts helpers by subject.

**Files:**
- Create: `tests/helpers/docx.ts`
- Modify: `tests/helpers/pdf.ts` — adds `textPdf` beside `blankPdf`
- Test: `tests/unit/agreement-import.test.ts` (extended in Task 4)

**Interfaces:**
- Consumes: `PDFDocument`, `StandardFonts` from `pdf-lib`; `crc32` from `node:zlib`.
- Produces:
  - `textPdf(lines: readonly { text: string; size: number }[]): Promise<Uint8Array>` in `tests/helpers/pdf.ts`
  - `docxWith(paragraphs: readonly { text: string; heading?: boolean }[]): Uint8Array` in `tests/helpers/docx.ts`
  - `blankPdf(pages = 1)`, which already exists, is what the "no extractable text" cases in Tasks 4, 7 and 8 use.

- [x] **Step 1: Add the text-bearing PDF beside `blankPdf`**

In `tests/helpers/pdf.ts`, add `StandardFonts` to the existing `pdf-lib` import and append:

```ts
/**
 * A PDF whose pages actually carry text, laid out top-down so the extractor
 * sees the vertical gaps it groups on. `size` is what makes a line a heading:
 * the grouper decides on relative size, so a fixture must vary it.
 */
export async function textPdf(
	lines: readonly { text: string; size: number }[]
): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([595, 842]);

	let y = 800;
	for (const line of lines) {
		page.drawText(line.text, { x: 50, y, size: line.size, font });
		y -= line.size * 1.6;
	}

	return pdf.save();
}
```

- [x] **Step 2: Write the DOCX builder**

Create `tests/helpers/docx.ts`:

```ts
import { crc32 } from 'node:zlib';

const DOCUMENT_XML_HEADER =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';

const CONTENT_TYPES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="xml" ContentType="application/xml"/>' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
	'</Types>';

const RELS =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
	'</Relationships>';

/**
 * A minimal but genuinely valid .docx — three parts in a ZIP. Written by hand
 * rather than with a library because the alternative is a binary fixture
 * nobody can read in a diff, and because a DOCX is only a ZIP of three XML
 * files when nothing in it is styled beyond a heading.
 */
export function docxWith(paragraphs: readonly { text: string; heading?: boolean }[]): Uint8Array {
	const body = paragraphs
		.map((paragraph) => {
			const style = paragraph.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : '';
			return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
		})
		.join('');

	return zipStored([
		{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
		{ name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
		{
			name: 'word/document.xml',
			data: Buffer.from(`${DOCUMENT_XML_HEADER}${body}</w:body></w:document>`, 'utf8')
		}
	]);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

interface ZipEntry {
	name: string;
	data: Buffer;
}

/** Store-only ZIP: no compression, so there is no deflate stream to get wrong. */
function zipStored(entries: readonly ZipEntry[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const sum = crc32(entry.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(sum, 16);
		central.writeUInt32LE(entry.data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);

		locals.push(local, name, entry.data);
		centrals.push(central, name);
		offset += local.length + name.length + entry.data.length;
	}

	const central = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);

	return new Uint8Array(Buffer.concat([...locals, central, end]));
}
```

- [x] **Step 3: Prove the DOCX is valid before anything depends on it**

A hand-written ZIP that is subtly wrong would surface later as a confusing `mammoth` failure inside another task. Install `mammoth` now and check the fixture through Vitest — add this to `tests/unit/agreement-import.test.ts`:

```sh
pnpm add mammoth
```

```ts
it('builds a docx mammoth can read', async () => {
	const mammoth = await import('mammoth');
	const { docxWith } = await import('../helpers/docx');

	const result = await mammoth.convertToHtml({ buffer: Buffer.from(docxWith([{ text: 'Hallo' }])) });

	expect(result.value).toContain('Hallo');
});
```

```sh
pnpm test:unit tests/unit/agreement-import.test.ts -t 'docx mammoth can read'
```

Expected: PASS. Keep this test — it is the only thing standing between a malformed fixture and an afternoon spent debugging the wrong file.

- [x] **Step 4: Prove `textPdf` and `blankPdf` differ in the way the extractor cares about**

`textPdf` is untested until Task 4 uses it, and a fixture that draws nothing would make Task 4's failures unreadable. Add one case using `drawnText`, which `tests/helpers/pdf.ts` already exports:

```ts
it('builds a pdf that carries text, and a blank one that does not', async () => {
	const { blankPdf, drawnText, textPdf } = await import('../helpers/pdf');

	expect(await drawnText(await textPdf([{ text: 'Vertraulich', size: 20 }]))).toContain(
		'Vertraulich'
	);
	expect(await drawnText(await blankPdf())).toBe('');
});
```

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
pnpm format
git add package.json pnpm-lock.yaml tests/helpers/docx.ts tests/helpers/pdf.ts tests/unit/agreement-import.test.ts
git commit -m "test: build a text-bearing pdf and a real docx in code"
```

---

### Task 4: PDF text reconstruction

§5.5 as amended: lines by baseline, paragraphs by vertical gap, headings by relative font size, and **enumerators stay literal text** (P3.21).

The last part needs no special code and that is the point worth understanding before writing any: the extractor emits mdast `paragraph` nodes, and `remark-stringify` escapes a paragraph beginning `1. ` as `1\. `. Re-parsing yields a paragraph whose text is `1. `, not an ordered list. The rule is enforced by the serializer rather than by a check somebody could forget, and Step 1's fourth test is what proves it.

**Files:**
- Create: `src/lib/server/nda/import/pdf.ts`
- Test: `tests/unit/agreement-import.test.ts`

**Interfaces:**
- Consumes: `getDocument` from `pdfjs-dist`; `remark-stringify`, `unified`; `Root`, `RootContent` from `mdast`.
- Produces: `pdfToMarkdown(bytes: Uint8Array): Promise<string>` and `export class PdfHasNoText extends Error {}`.

- [x] **Step 1: Install pdfjs and find the import path that works under Node**

`pdfjs-dist` ships several builds and only the legacy one runs under Node without a browser worker. Establish which specifier resolves before writing code against it:

`remark-stringify` is installed here rather than in Task 5 because the extractor
below serialises through it — it is what enforces P3.21.

```sh
pnpm add pdfjs-dist remark-stringify
node --input-type=module -e "const m = await import('pdfjs-dist/legacy/build/pdf.mjs'); console.log(typeof m.getDocument);"
```

Expected: `function`. If it throws, try in order `pdfjs-dist/legacy/build/pdf.js`, then `pdfjs-dist`, and use whichever prints `function`. Record the working specifier in the module comment — the next reader will not want to repeat this.

- [x] **Step 2: Write the failing tests**

Append to `tests/unit/agreement-import.test.ts`:

```ts
import { PdfHasNoText, pdfToMarkdown } from '../../src/lib/server/nda/import/pdf';
import { blankPdf, textPdf } from '../helpers/pdf';

describe('pdfToMarkdown', () => {
	it('promotes a larger line to a heading and keeps body text as paragraphs', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: 'Die Parteien vereinbaren Folgendes.', size: 11 }
			])
		);

		expect(markdown).toContain('# Vertraulichkeitsvereinbarung');
		expect(markdown).toContain('Die Parteien vereinbaren Folgendes.');
	});

	it('keeps an enumerated clause as text, not as a list', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: '1. Definitionen im Sinne dieser Vereinbarung.', size: 11 },
				{ text: '2. Geheimhaltung der offengelegten Informationen.', size: 11 }
			])
		);

		// The escape is what makes this true, and it is why the serializer does
		// the enforcing (P3.21): our renderer numbers list items itself, so a
		// clause imported as a list item can render under a different number
		// than the contract it came from.
		expect(markdown).toContain('1\\. Definitionen');

		const root = parseAgreementBody(markdown);
		expect(root.children.some((node) => node.type === 'list')).toBe(false);
	});

	it('produces a body the subset validator accepts', async () => {
		const markdown = await pdfToMarkdown(
			await textPdf([
				{ text: 'Titel', size: 20 },
				{ text: 'Ein Absatz mit Text.', size: 11 }
			])
		);

		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});

	it('refuses a PDF with no extractable text', async () => {
		await expect(pdfToMarkdown(await blankPdf())).rejects.toBeInstanceOf(PdfHasNoText);
	});
});
```

Add `parseAgreementBody` back to the `subset` import at the top of the file:

```ts
import { parseAgreementBody, SUBSET_NODE_TYPES } from '../../src/lib/markdown/subset';
```

- [x] **Step 3: Run them to verify they fail**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: FAIL — cannot resolve `../../src/lib/server/nda/import/pdf`.

- [x] **Step 4: Write the extractor**

Create `src/lib/server/nda/import/pdf.ts`:

```ts
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';
// The legacy build is the one that runs under Node without a browser worker —
// see this task's step 1 if the specifier ever stops resolving.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * A PDF that yields no text is a scan, and §5.5 refuses it by name rather than
 * importing an empty body somebody then has to explain.
 */
export class PdfHasNoText extends Error {
	constructor() {
		super('This PDF contains no extractable text — it is probably a scan.');
		this.name = 'PdfHasNoText';
	}
}

/**
 * §16 asks for these to be named rather than inlined, because they are the
 * part of this file most likely to be wrong on the first real contract and the
 * cheapest thing to correct when it is.
 */
/** Two points of drift still counts as the same baseline. */
const LINE_TOLERANCE_PT = 2;
/** A vertical gap wider than this many line-heights starts a new paragraph. */
const PARAGRAPH_GAP_RATIO = 1.8;
/** Bigger than the body by this much is a heading. */
const HEADING_SIZE_RATIO = 1.15;
/** Bigger than the body by this much is the document's title. */
const TITLE_SIZE_RATIO = 1.5;

interface Line {
	text: string;
	size: number;
	/** Distance from this line's baseline down to the next one, in points. */
	gapBelow: number;
}

const serializer = unified().use(remarkStringify, { bullet: '-', rule: '-' });

/**
 * Positioned runs in, canonical Markdown out. A PDF carries no headings, no
 * lists and no paragraph boundaries — only glyphs at coordinates — so
 * everything here is reconstruction, and §5.5 bounds how much of it we attempt.
 */
export async function pdfToMarkdown(bytes: Uint8Array): Promise<string> {
	const lines = await extractLines(bytes);
	if (lines.length === 0) throw new PdfHasNoText();

	const body = bodySize(lines);
	const children: RootContent[] = [];
	let paragraph: string[] = [];

	const flush = (): void => {
		if (paragraph.length === 0) return;
		children.push({ type: 'paragraph', children: [{ type: 'text', value: paragraph.join(' ') }] });
		paragraph = [];
	};

	for (const line of lines) {
		if (line.size >= body * HEADING_SIZE_RATIO) {
			flush();
			children.push({
				type: 'heading',
				depth: line.size >= body * TITLE_SIZE_RATIO ? 1 : 2,
				children: [{ type: 'text', value: line.text }]
			});
			continue;
		}

		paragraph.push(line.text);
		if (line.gapBelow > line.size * PARAGRAPH_GAP_RATIO) flush();
	}

	flush();

	const root: Root = { type: 'root', children };

	// `remark-stringify` escapes a paragraph beginning `1. ` as `1\. `, which is
	// what keeps an enumerated clause out of an ordered list on the way back in
	// (P3.21). The rule is the serializer's, not a check a later edit could drop.
	return serializer.stringify(root);
}

interface PositionedItem {
	str: string;
	transform: number[];
	height: number;
}

async function extractLines(bytes: Uint8Array): Promise<Line[]> {
	// `useSystemFonts: false` because glyph positions are all we read and font
	// loading is cost without a reader. There is deliberately no
	// `isEvalSupported: false` beside it, which this file would otherwise want
	// against an operator-supplied document: pdfjs-dist 6 removed the option
	// along with the eval path it guarded, and passing it now fails typecheck.
	//
	// The loading task, not the document proxy, is what owns teardown: as of
	// pdfjs-dist 6 the proxy has only `cleanup()`, and calling `destroy()` on it
	// throws. Holding the task is what lets the worker be torn down at all.
	const task = getDocument({ data: bytes, useSystemFonts: false });

	const lines: Line[] = [];

	try {
		const pdf = await task.promise;
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			lines.push(...groupIntoLines(content.items as PositionedItem[]));
		}
	} finally {
		await task.destroy();
	}

	return lines;
}

/** Items sharing a baseline become one line, left to right, top-down. */
function groupIntoLines(items: readonly PositionedItem[]): Line[] {
	const drawn = items.filter((item) => item.str.trim().length > 0);
	if (drawn.length === 0) return [];

	const sorted = [...drawn].sort((left, right) => {
		const dy = right.transform[5]! - left.transform[5]!;
		return Math.abs(dy) > LINE_TOLERANCE_PT ? dy : left.transform[4]! - right.transform[4]!;
	});

	const grouped: { y: number; size: number; parts: string[] }[] = [];

	for (const item of sorted) {
		const y = item.transform[5]!;
		const last = grouped.at(-1);

		if (last && Math.abs(last.y - y) <= LINE_TOLERANCE_PT) {
			last.parts.push(item.str);
			last.size = Math.max(last.size, item.height);
			continue;
		}

		grouped.push({ y, size: item.height, parts: [item.str] });
	}

	return grouped.map((line, index) => ({
		text: line.parts.join('').replace(/\s+/g, ' ').trim(),
		size: line.size,
		// The last line of a page has no measurable gap; treating it as infinite
		// ends the paragraph there, which is right at a page boundary and
		// harmless in the middle of one.
		gapBelow: grouped[index + 1] ? line.y - grouped[index + 1]!.y : Number.POSITIVE_INFINITY
	}));
}

/** The most common line size, which is the body text of any real contract. */
function bodySize(lines: readonly Line[]): number {
	const counts = new Map<number, number>();
	for (const line of lines) {
		const size = Math.round(line.size * 2) / 2;
		counts.set(size, (counts.get(size) ?? 0) + 1);
	}

	let best = 0;
	let seen = -1;
	for (const [size, count] of counts) {
		// A tie goes to the smaller size, because a title never outnumbers the
		// body it titles. Without that rule a document short enough for its
		// heading to tie with its body — an excerpt, a one-clause amendment —
		// takes the heading as the body and then nothing clears the heading
		// ratio, so the import comes back as one flat run of paragraphs.
		if (count > seen || (count === seen && size < best)) {
			best = size;
			seen = count;
		}
	}

	return best;
}
```

- [x] **Step 5: Run the tests to verify they pass**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: PASS. `item.height` was measured to carry the drawn point size exactly under `pdfjs-dist` 6.3.289 (20 and 11 for the fixture above), so no transform-matrix fallback is needed; should a later version return `0`, read the size off the matrix instead — `Math.hypot(transform[2], transform[3])` — and keep the rest unchanged. Adjust the constants only if a fixture case fails, never to make a real document look nicer; §16 records that tuning against documents we do not have is the known unknown here.

- [x] **Step 6: Commit**

```sh
pnpm format
git add package.json pnpm-lock.yaml src/lib/server/nda/import/pdf.ts tests/unit/agreement-import.test.ts
git commit -m "feat(nda): reconstruct paragraphs and headings from a pdf"
```

---

### Task 5: DOCX conversion

`mammoth` yields semantic HTML; the unified family already in this repo takes it from there (P3.23, §13). Turndown is deliberately not used: §13's argument for `remark-parse` was that a shared AST keeps the validator, the renderer, the PDF layout and the editor agreeing rather than approximately agreeing, and a second string-based converter is a second opinion about the same conversion.

**Files:**
- Create: `src/lib/server/nda/import/docx.ts`
- Test: `tests/unit/agreement-import.test.ts`

**Interfaces:**
- Consumes: `mammoth`; `rehype-parse`, `rehype-remark`, `remark-stringify`, `unified`; `downgradeToSubset` from `src/lib/markdown/downgrade.ts`.
- Produces: `docxToMarkdown(bytes: Uint8Array): Promise<{ markdown: string; dropped: string[] }>`

- [x] **Step 1: Install the conversion chain**

```sh
pnpm add rehype-parse rehype-remark
```

`mammoth` was installed in Task 3, `remark-stringify` in Task 4.

- [x] **Step 2: Write the failing tests**

Append to `tests/unit/agreement-import.test.ts`:

```ts
import { docxToMarkdown } from '../../src/lib/server/nda/import/docx';
import { docxWith } from '../helpers/docx';

describe('docxToMarkdown', () => {
	it('carries a heading and a paragraph into the subset', async () => {
		const { markdown, dropped } = await docxToMarkdown(
			docxWith([
				{ text: 'Vertraulichkeitsvereinbarung', heading: true },
				{ text: 'Die Parteien vereinbaren Folgendes.' }
			])
		);

		expect(markdown).toContain('Vertraulichkeitsvereinbarung');
		expect(markdown).toContain('Die Parteien vereinbaren Folgendes.');
		expect(dropped).toEqual([]);
		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});

	it('keeps an enumerated clause as text', async () => {
		const { markdown } = await docxToMarkdown(
			docxWith([{ text: '1. Definitionen im Sinne dieser Vereinbarung.' }])
		);

		const root = parseAgreementBody(markdown);
		expect(root.children.some((node) => node.type === 'list')).toBe(false);
	});

	it('produces a body the subset validator accepts, whatever came in', async () => {
		const { markdown } = await docxToMarkdown(
			docxWith([{ text: 'Ein Absatz.' }, { text: 'Noch einer.' }])
		);

		expect(() => parseAgreementBody(markdown)).not.toThrow();
	});
});
```

- [x] **Step 3: Run them to verify they fail**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts -t docxToMarkdown
```

Expected: FAIL — cannot resolve `../../src/lib/server/nda/import/docx`.

- [x] **Step 4: Write the converter**

Create `src/lib/server/nda/import/docx.ts`:

```ts
import mammoth from 'mammoth';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Root } from 'mdast';
import { downgradeToSubset } from '../../../markdown/downgrade';

const toMdast = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark);
const serializer = unified().use(remarkStringify, { bullet: '-', rule: '-' });

/**
 * DOCX → semantic HTML → mdast → the subset → Markdown.
 *
 * The middle two steps are the unified family `remark-parse` already belongs
 * to, rather than a string-based converter such as turndown: §13 chose a shared
 * AST so the validator, the renderer, the PDF layout and the editor agree
 * rather than approximately agree, and that argument covers the import path too
 * (P3.23).
 *
 * `dropped` names what the downgrade removed, so the author is told at the
 * moment they can still fix it — a real contract carries links and tables, and
 * refusing the document for containing one would make this useless on exactly
 * the input it exists for.
 */
export async function docxToMarkdown(
	bytes: Uint8Array
): Promise<{ markdown: string; dropped: string[] }> {
	const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });

	const parsed = toMdast.runSync(toMdast.parse(html)) as Root;
	const { root, dropped } = downgradeToSubset(parsed);

	return { markdown: serializer.stringify(root), dropped };
}
```

- [x] **Step 5: Run the tests to verify they pass**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: PASS, every case in the file.

- [x] **Step 6: Commit**

```sh
pnpm format
git add package.json pnpm-lock.yaml src/lib/server/nda/import/docx.ts tests/unit/agreement-import.test.ts
git commit -m "feat(nda): convert a docx into the canonical body"
```

---

### Task 6: One entry point for import

Routes should not know which library reads which format. One function, dispatching on the content type the upload already carries.

**Files:**
- Create: `src/lib/server/nda/import/index.ts`
- Test: `tests/unit/agreement-import.test.ts`

**Interfaces:**
- Consumes: `UploadedFile`, `UploadRejected` from `src/lib/server/upload.ts`; `pdfToMarkdown`; `docxToMarkdown`.
- Produces:
  - `interface ImportedBody { markdown: string; dropped: string[] }`
  - `importAgreementBody(file: UploadedFile): Promise<ImportedBody>`
  - `const IMPORT_TYPES: readonly string[]` — the allowed upload types, for the route's `readUpload` limits.

- [x] **Step 1: Write the failing tests**

Append to `tests/unit/agreement-import.test.ts`:

```ts
import { importAgreementBody, IMPORT_TYPES } from '../../src/lib/server/nda/import';
import { UploadRejected } from '../../src/lib/server/upload';

describe('importAgreementBody', () => {
	it('reads a pdf', async () => {
		const bytes = await textPdf([{ text: 'Ein Absatz.', size: 11 }]);

		const imported = await importAgreementBody({
			filename: 'a.pdf',
			contentType: 'application/pdf',
			bytes
		});

		expect(imported.markdown).toContain('Ein Absatz.');
		expect(imported.dropped).toEqual([]);
	});

	it('reads a docx', async () => {
		const imported = await importAgreementBody({
			filename: 'a.docx',
			contentType: IMPORT_TYPES[1]!,
			bytes: docxWith([{ text: 'Ein Absatz.' }])
		});

		expect(imported.markdown).toContain('Ein Absatz.');
	});

	it('refuses a type it cannot read', async () => {
		await expect(
			importAgreementBody({ filename: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array() })
		).rejects.toBeInstanceOf(UploadRejected);
	});
});
```

- [x] **Step 2: Run them to verify they fail**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts -t importAgreementBody
```

Expected: FAIL — cannot resolve `../../src/lib/server/nda/import`.

- [x] **Step 3: Write the entry point**

Create `src/lib/server/nda/import/index.ts`:

```ts
import { UploadRejected, type UploadedFile } from '../../upload';
import { docxToMarkdown } from './docx';
import { pdfToMarkdown } from './pdf';

/** What the version editor's import control accepts. */
export const IMPORT_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

export interface ImportedBody {
	markdown: string;
	/** Node types the conversion removed or rewrote; empty for a clean import. */
	dropped: string[];
}

/**
 * The one thing a route imports. Which library reads which format is this
 * module's business, and keeping it here is what stops `pdfjs-dist` and
 * `mammoth` from being named in a route — §10.4 confines both to the admin
 * side, and a route is where that boundary is easiest to lose.
 *
 * Nothing here writes. §5.5 makes import a drafting aid whose output a human
 * reads before `?/saveBody` stores it (P3.22).
 */
export async function importAgreementBody(file: UploadedFile): Promise<ImportedBody> {
	if (file.contentType === 'application/pdf') {
		return { markdown: await pdfToMarkdown(file.bytes), dropped: [] };
	}

	if (file.contentType === IMPORT_TYPES[1]) {
		return docxToMarkdown(file.bytes);
	}

	throw new UploadRejected(`Cannot import a file of type "${file.contentType}".`);
}
```

- [x] **Step 4: Run the tests to verify they pass**

```sh
pnpm test:unit tests/unit/agreement-import.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
pnpm format
git add src/lib/server/nda/import/index.ts tests/unit/agreement-import.test.ts
git commit -m "feat(nda): one entry point for agreement import"
```

---

### Task 7: The `?/import` action

Import returns a draft to the page and writes nothing (P3.22). It refuses a version somebody has already accepted, and reuses the upload caps the documents route already applies rather than inventing a second set.

**Files:**
- Modify: `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.server.ts`
- Test: `tests/integration/nda-import.test.ts` (create)

**Interfaces:**
- Consumes: `importAgreementBody`, `IMPORT_TYPES`, `ImportedBody`; `readUpload`, `UploadRejected`, `assertPdfPages`; `PdfHasNoText`.
- Produces: an action returning `{ imported: { locale: string; markdown: string; dropped: string[] } }` on success, or `fail(400 | 409, { field: 'import', message })` where `message` is one of `'immutable'`, `'no-text'`, or the `UploadRejected` text.

- [x] **Step 1: Write the failing integration test**

Create `tests/integration/nda-import.test.ts`. Model the setup on the existing `tests/integration/nda-*.test.ts` files — read one first for how they build a db, seed a template and clean up, and follow it exactly, including cleaning children before parents (`nda_acceptance.version_id` and `access_group.nda_template_id` are both `ON DELETE RESTRICT`; the 3c carry-over records three files bitten by this).

```ts
import { describe, expect, it } from 'vitest';
import { importAgreementBody } from '../../src/lib/server/nda/import';
import { PdfHasNoText } from '../../src/lib/server/nda/import/pdf';
import { blankPdf, textPdf } from '../helpers/pdf';

describe('agreement import', () => {
	it('names a scan rather than importing an empty body', async () => {
		await expect(
			importAgreementBody({
				filename: 'scan.pdf',
				contentType: 'application/pdf',
				bytes: await blankPdf()
			})
		).rejects.toBeInstanceOf(PdfHasNoText);
	});

	it('imports a pdf into markdown the subset accepts', async () => {
		const imported = await importAgreementBody({
			filename: 'nda.pdf',
			contentType: 'application/pdf',
			bytes: await textPdf([
				{ text: 'Vertraulichkeitsvereinbarung', size: 20 },
				{ text: '1. Definitionen.', size: 11 }
			])
		});

		expect(imported.markdown).toContain('Vertraulichkeitsvereinbarung');
	});
});
```

The immutability refusal is asserted through the browser in Task 8, where the action is actually reachable; asserting it here would mean calling a SvelteKit action out of its route, which no other test in this suite does.

- [x] **Step 2: Run it to verify it fails**

```sh
pnpm test:integration tests/integration/nda-import.test.ts
```

Expected: FAIL — cannot resolve the import module (it exists after Task 6, so if this passes immediately, that is fine: the point of the file is that it keeps passing).

- [x] **Step 3: Add the action**

In `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.server.ts`, extend the imports:

```ts
import { IMPORT_TYPES, importAgreementBody } from '$lib/server/nda/import';
import { PdfHasNoText } from '$lib/server/nda/import/pdf';
import { assertPdfPages, readUpload, UploadRejected } from '$lib/server/upload';
```

Then add the action after `saveBody` and before `publish`:

```ts
	/**
	 * §5.5: extract and hand back, never write. `?/saveBody` stays the only
	 * writer, which is what keeps this phase from minting an audit action name
	 * for a step whose whole purpose is to be reviewed before it counts (P3.22)
	 * — and names are permanent once written.
	 */
	import: async (event) => {
		const db = getDb();
		const form = await event.request.formData();
		const locale = String(form.get('locale') ?? '');

		if (!getConfig().locales.includes(locale)) {
			return fail<VersionFailure>(400, { field: 'import', message: 'locale' });
		}

		// A version somebody has accepted is immutable, so offering to replace
		// its body would be offering something the save would then refuse.
		const [version] = await db
			.select({ firstAcceptedAt: ndaTemplateVersion.firstAcceptedAt })
			.from(ndaTemplateVersion)
			.where(eq(ndaTemplateVersion.id, event.params.versionId))
			.limit(1);

		if (version?.firstAcceptedAt) {
			return fail<VersionFailure>(409, { field: 'import', message: 'immutable' });
		}

		try {
			const upload = await readUpload(form, 'file', {
				maxBytes: getConfig().maxUploadBytes,
				allowedTypes: IMPORT_TYPES
			});

			// The same bound the documents route applies, for the same reason:
			// parsing a thousand-page PDF is what the page cap limits, and this
			// is the second route that reads one.
			if (upload.contentType === 'application/pdf') {
				await assertPdfPages(upload.bytes, getConfig().maxPdfPages);
			}

			const imported = await importAgreementBody(upload);
			return { imported: { locale, ...imported } };
		} catch (cause) {
			if (cause instanceof PdfHasNoText) {
				return fail<VersionFailure>(400, { field: 'import', message: 'no-text' });
			}
			if (cause instanceof UploadRejected) {
				return fail<VersionFailure>(400, { field: 'import', message: cause.message });
			}
			throw cause;
		}
	},
```

- [x] **Step 4: Verify**

```sh
pnpm test:integration tests/integration/nda-import.test.ts
pnpm check
```

Expected: tests PASS; `pnpm check` reports 0 errors and 0 warnings. If `check` complains that the action's return type widens the page's `form` union, that is expected and correct — Task 8 consumes it.

- [x] **Step 5: Commit**

```sh
pnpm format
git add "src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.server.ts" tests/integration/nda-import.test.ts
git commit -m "feat(nda): import a pdf or docx into a draft body"
```

---

### Task 8: The import control on the version editor — Gate 1

A file input per locale, the extracted Markdown loaded into that locale's field unsaved, and a notice naming what the downgrade removed. The author then reads it, edits it, and saves through the existing button.

This task targets the **textarea**, which is still what the page renders. Task 10 swaps that for Milkdown and re-points the same effect; doing it in this order keeps each theme independently reachable, which is the arrangement §3 chose.

**Files:**
- Modify: `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`
- Test: `tests/e2e/admin-agreements.spec.ts`

**Interfaces:**
- Consumes: the `?/import` action's `{ imported: { locale, markdown, dropped } }` from Task 7.
- Produces: `data-testid` values later tasks drive — `import-file-{locale}`, `import-submit-{locale}`, `import-dropped-{locale}`, `import-error`.

- [x] **Step 1: Add the message keys**

To `messages/en.json`:

```json
	"admin_agreement_import": "Import a PDF or Word file",
	"admin_agreement_import_submit": "Import",
	"admin_agreement_import_dropped": "Removed on import, because the agreement format cannot show it: {types}. Check the text before saving.",
	"admin_agreement_import_no_text": "This PDF contains no text to import — it is probably a scan.",
	"admin_agreement_import_failed": "This file could not be imported: {reason}",
```

To `messages/de.json`:

```json
	"admin_agreement_import": "PDF oder Word-Datei importieren",
	"admin_agreement_import_submit": "Importieren",
	"admin_agreement_import_dropped": "Beim Import entfernt, weil das Vertragsformat es nicht darstellen kann: {types}. Bitte den Text vor dem Speichern prüfen.",
	"admin_agreement_import_no_text": "Dieses PDF enthält keinen Text zum Importieren — vermutlich ein Scan.",
	"admin_agreement_import_failed": "Diese Datei konnte nicht importiert werden: {reason}",
```

Keep both files in the same key order; `pnpm check` compiles the catalogs first and will fail on a malformed one.

- [x] **Step 2: Extract the setup the new cases need**

`tests/e2e/admin-agreements.spec.ts` has no helper for reaching a draft version — the five existing cases each inline it. Three more cases are about to need it, so extract it first, from the case at line 35 (`a body is previewed before it can be published`), without changing what that case asserts.

It goes in `tests/helpers/admin.ts`, not in the spec: Step 6 needs it from a second spec file and Playwright refuses to let one test file import another. It signs in itself, so a caller is one line.

```ts
/** Signs in, creates an agreement, adds a version, returns the editor's URL. */
export async function draftVersion(page: Page): Promise<string> {
	// Lift the body of the existing setup here verbatim, then have the cases
	// that inlined it call this instead. Extracting rather than duplicating,
	// because a second copy of a nine-step setup is how two specs come to
	// disagree about what a draft version is.

	// Clicking `version-1` is a client-side navigation, and `networkidle` can
	// be satisfied before the router has swapped the URL. Wait for the version
	// URL before reading `page.url()`, or the helper returns the agreement page
	// and every caller loads the wrong one — the existing cases never noticed,
	// because they use the page they are on rather than the URL.
	await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
}
```

Run the file before continuing:

```sh
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app
```

Expected: PASS, unchanged — this step refactors the spec and asserts nothing new.

- [x] **Step 3: Write the failing e2e case**

Append to `tests/e2e/admin-agreements.spec.ts`:

```ts
test('imports a docx into a draft body without saving it', async ({ page }) => {
	const versionUrl = await draftVersion(page);
	await page.goto(versionUrl);
	await awaitHydration(page);

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'nda.docx',
		mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		buffer: Buffer.from(
			docxWith([
				{ text: 'Vertraulichkeitsvereinbarung', heading: true },
				{ text: '1. Definitionen.' }
			])
		)
	});

	await submitAndWait(page, 'import-submit-de', '?/import');

	await expect(page.getByTestId('body-de')).toHaveValue(/Vertraulichkeitsvereinbarung/);

	// Import writes nothing (P3.22): a reload must show the body as it was.
	await page.reload();
	await awaitHydration(page);
	await expect(page.getByTestId('body-de')).not.toHaveValue(/Vertraulichkeitsvereinbarung/);
});
```

Import `docxWith` from `../helpers/docx` and `awaitHydration` from `../helpers/hydration`, matching how the file already imports its helpers.

- [x] **Step 4: Run it to verify it fails**

```sh
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app -t 'imports a docx'
```

Expected: FAIL — no element with test id `import-file-de`.

- [x] **Step 5: Render the import control**

In the `.svelte`, extend the script:

```ts
	// What each locale's editor holds. Seeded here rather than in the effect
	// below so the server renders the stored body: effects do not run during
	// SSR, and an editor that only fills in after hydration would make the page
	// depend on JavaScript to show what it is editing. Capturing the initial
	// value is the intent — the effect owns every later change — so the warning
	// about it is silenced deliberately, and `pnpm check` ends at 0 warnings.
	// svelte-ignore state_referenced_locally
	let bodies = $state<Record<string, string>>(
		Object.fromEntries(data.locales.map((locale) => [locale, data.bodies[locale]?.bodyMd ?? '']))
	);

	// Replaced wholesale when the load changes, and when an import returns. The
	// textarea is bound to this rather than reading `data` directly, because an
	// import result has to reach it without a save having happened.
	$effect(() => {
		for (const locale of data.locales) {
			bodies[locale] = data.bodies[locale]?.bodyMd ?? '';
		}
	});

	$effect(() => {
		const imported = form && 'imported' in form ? form.imported : null;
		if (imported) bodies[imported.locale] = imported.markdown;
	});
```

Inside the `{#each data.locales as locale}` block, above the existing `FormField`, add the import control. It must be **outside** the `saveBody` form — nested forms are invalid HTML and the browser drops the inner one:

```svelte
			<div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
				<label for="import-{locale}">{m.admin_agreement_import()}</label>
				<input
					id="import-{locale}"
					data-testid="import-file-{locale}"
					form="import-form-{locale}"
					type="file"
					name="file"
					accept=".pdf,.docx"
					disabled={immutable}
				/>
				<button
					data-testid="import-submit-{locale}"
					form="import-form-{locale}"
					class="rounded border px-3 py-1.5"
					disabled={immutable}>{m.admin_agreement_import_submit()}</button
				>
			</div>
```

And after the `saveBody` form, one bare form per locale for those controls to post to. Its id is **not** the file input's: `form=` resolves against every element id, so a form sharing `import-{locale}` with the input associates the button with the input instead — the button then does nothing at all when clicked, silently.

```svelte
{#each data.locales as locale (locale)}
	<form id="import-form-{locale}" method="POST" action="?/import" enctype="multipart/form-data" use:enhance>
		<input type="hidden" name="locale" value={locale} />
	</form>
{/each}
```

Change the textarea to bind:

```svelte
				<textarea
					data-testid="body-{locale}"
					name="body.{locale}"
					readonly={immutable}
					rows="8"
					bind:value={bodies[locale]}
					class="w-full rounded border px-2 py-1 font-mono"
				></textarea>
```

Note the tag no longer wraps content — a bound `textarea` must be self-closed with `bind:value`, or Svelte will warn about a value being set two ways.

Then the notices, after the existing `form?.field === 'body'` block:

```svelte
	{#if form?.field === 'import'}
		{#if form.message === 'immutable'}
			<p class="text-sm text-amber-700">{m.admin_agreement_version_immutable()}</p>
		{:else if form.message === 'no-text'}
			<p data-testid="import-error" class="text-sm text-red-700">
				{m.admin_agreement_import_no_text()}
			</p>
		{:else}
			<p data-testid="import-error" class="text-sm text-red-700">
				{m.admin_agreement_import_failed({ reason: form.message ?? '' })}
			</p>
		{/if}
	{/if}
```

And the dropped-node notice, inside the per-locale block:

```svelte
			{#if form && 'imported' in form && form.imported?.locale === locale && form.imported.dropped.length > 0}
				<p data-testid="import-dropped-{locale}" class="mt-2 text-sm text-amber-700">
					{m.admin_agreement_import_dropped({ types: form.imported.dropped.join(', ') })}
				</p>
			{/if}
```

- [x] **Step 6: Extend the upload spec to the second upload route**

§14 folded an end-to-end test of the admin file upload into 3b precisely because 3c adds a second upload route that would otherwise inherit the gap. Add to `tests/e2e/admin-upload.spec.ts`, whose `MAX_PAGES` and `MAX_BYTES` already match the lowered caps in `playwright.config.ts`'s webServer env:

```ts
test('the import route refuses a pdf over the page cap', async ({ page }) => {
	const versionUrl = await draftVersion(page); // export it from admin-agreements.spec.ts or inline the setup
	await page.goto(versionUrl);
	await awaitHydration(page);

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'huge.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(await blankPdf(MAX_PAGES + 1))
	});

	await submitAndWait(page, 'import-submit-de', '?/import');
	await expect(page.getByTestId('import-error')).toBeVisible();
});

test('the import route refuses a scan', async ({ page }) => {
	const versionUrl = await draftVersion(page);
	await page.goto(versionUrl);
	await awaitHydration(page);

	await page.getByTestId('import-file-de').setInputFiles({
		name: 'scan.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(await blankPdf())
	});

	await submitAndWait(page, 'import-submit-de', '?/import');
	await expect(page.getByTestId('import-error')).toBeVisible();
});
```

If sharing `draftVersion` across two spec files is awkward, move it into `tests/helpers/admin.ts` alongside the other cross-spec helpers rather than copying it.

- [x] **Step 7: Verify**

```sh
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app
pnpm test:e2e tests/e2e/admin-upload.spec.ts --project=app
pnpm check
```

Expected: PASS; 0 errors, 0 warnings.

- [x] **Step 8: Commit**

```sh
pnpm format
git add "src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.svelte" messages tests/e2e/admin-agreements.spec.ts tests/e2e/admin-upload.spec.ts
git commit -m "feat(admin): import a contract into a draft agreement body"
```

- [x] **Step 9: Gate 1 — the import theme is complete**

```sh
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. Do not start Task 9 until this passes. If it does not, fix forward here — the next theme changes the same page.

---

### Task 9: The Milkdown editor component

One editor per locale, writing through to a hidden textarea so `?/saveBody`'s POST shape is untouched. Loaded through a dynamic `import()` inside `onMount`, which is what keeps `@milkdown/*` in an admin chunk and out of every public route (§10.4).

§16 names the real hazard, and it is not rendering: ProseMirror owns its DOM, so a reactive re-render must not re-create it, and its content must reach the textarea before the form submits. A lost keystroke produces a **passing** test over a body that was never written — the same shape as the suite's four hydration-race sightings.

**Files:**
- Create: `src/lib/components/admin/MarkdownEditor.svelte`
- Modify: `package.json`

**Interfaces:**
- Consumes: `@milkdown/core`, `@milkdown/preset-commonmark`, `@milkdown/theme-nord`, `@milkdown/plugin-listener`.
- Produces: a component taking `{ name: string; value?: string; readonly?: boolean; testId?: string }` and exposing `setMarkdown(markdown: string): void` through `bind:this`.

- [x] **Step 1: Install and look at what the preset actually exports**

```sh
pnpm add @milkdown/core @milkdown/preset-commonmark @milkdown/theme-nord @milkdown/plugin-listener
node --input-type=module -e "const m = await import('@milkdown/preset-commonmark'); console.log(Object.keys(m).filter(k => /Schema$/.test(k)).join(' '));"
```

Expected: a list including `blockquoteSchema`, `imageSchema`, `codeBlockSchema`, `inlineCodeSchema`, `linkSchema`. Write down what it prints — Step 3 filters against these exact names.

- [x] **Step 2: Decide the schema question, once, with a time bound**

§5.1 wants the editor's ProseMirror schema restricted to `SUBSET_NODE_TYPES`, and says plainly that a client-side schema is a convenience and never the control.

Filter the commonmark preset by removing the schema plugins for the nodes outside the subset. **If that cannot be made to work in the installed version within this task, ship the full commonmark preset**, add `admin_agreement_body_not_in_subset` coverage to the e2e in Task 11 so the server refusal is visibly the control, and open a carry-over item. Do not spend a second task on it: the server refusal plus the preview is what §5.1 says the control actually is.

- [x] **Step 3: Write the component**

Create `src/lib/components/admin/MarkdownEditor.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	// Type-only, so nothing from `@milkdown/*` reaches the bundle from here —
	// the value imports below are dynamic on purpose (§10.4).
	import type { Editor } from '@milkdown/core';

	let {
		name,
		value = '',
		readonly = false,
		testId
	}: { name: string; value?: string; readonly?: boolean; testId?: string } = $props();

	// The textarea is the form's field and the editor's mirror. Keeping it means
	// `?/saveBody` never learns that the editor exists — the POST shape is the
	// one Phase 3b established, and a body typed into a browser with JavaScript
	// disabled still submits.
	// The prop seeds the editor once; every later change comes through
	// `setMarkdown`, which the page calls when an import returns.
	// svelte-ignore state_referenced_locally
	let markdown = $state(value);
	let host: HTMLDivElement | undefined = $state();
	let field: HTMLTextAreaElement | undefined = $state();
	let editor: Editor | null = null;
	/** Serialises the live ProseMirror document; null until the editor mounts. */
	let readMarkdown: (() => string) | null = null;
	/**
	 * Whether something other than the editor wrote the field last. An `input`
	 * event on a hidden textarea cannot come from a person — Svelte's binding
	 * writes the property without dispatching one — so the only source is script:
	 * a paste of raw Markdown, or a client with the editor disabled. Whoever
	 * wrote last owns the value, because the field is what the form posts and
	 * §5.1 puts the control at the server, not at the editor's schema.
	 */
	let writtenFromOutside = false;

	/** Called from the page when an import returns a new body for this locale. */
	export function setMarkdown(next: string): void {
		markdown = next;
		writtenFromOutside = false;
		// Replacing the document from outside means tearing the editor down and
		// building it again: ProseMirror owns its DOM and there is no supported
		// way to swap a document under it without losing the selection anyway.
		void remount();
	}

	async function remount(): Promise<void> {
		await editor?.destroy();
		editor = null;
		await mount();
	}

	async function mount(): Promise<void> {
		if (readonly || !host) return;

		// Dynamic, so `@milkdown/*` lands in an admin chunk and no public route
		// ever loads it (§10.4). Static imports here would put it in the shared
		// entry and break that guarantee silently.
		const [
			{ Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx },
			commonmark,
			{ listener, listenerCtx },
			{ nord }
		] = await Promise.all([
			import('@milkdown/core'),
			import('@milkdown/preset-commonmark'),
			import('@milkdown/plugin-listener'),
			import('@milkdown/theme-nord'),
			// `nord` only sets view options; its stylesheet is a separate entry,
			// and without it Tailwind's reset leaves a heading looking like body
			// text in the one place an author is judging structure.
			import('@milkdown/theme-nord/style.css')
		]);

		const root = host;

		editor = await Editor.make()
			.config(nord)
			.config((ctx) => {
				ctx.set(rootCtx, root);
				ctx.set(defaultValueCtx, markdown);
				ctx.get(listenerCtx).markdownUpdated((_, next) => {
					markdown = next;
					writtenFromOutside = false;
				});
			})
			.use(listener)
			.use(subsetOnly(commonmark))
			.create();

		readMarkdown = () =>
			editor?.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)) ?? markdown;
	}

	type Preset = typeof import('@milkdown/preset-commonmark');
	/**
	 * What `Editor.use` accepts, read off the method because `@milkdown/ctx` —
	 * where `MilkdownPlugin` lives — is not a direct dependency of this project.
	 */
	type Plugins = Parameters<Editor['use']>[0];

	/**
	 * The nodes §5.1 leaves out of the subset. Matched against the preset's own
	 * export names rather than listed plugin by plugin, because every node ships
	 * a schema, attributes, a keymap, input rules and commands — and dropping a
	 * schema while keeping the input rule that looks its type up throws at
	 * creation, which is a blank editor rather than a message.
	 */
	const EXCLUDED_NODES = ['blockquote', 'image', 'codeblock', 'inlinecode', 'link', 'html'];

	/**
	 * §5.1: the editor must not offer what the server is going to refuse — an
	 * offer accepted and then rejected is a worse failure than one never made.
	 * This is a convenience and never the control; `parseAgreementBody` is, and
	 * the preview beside the editor is what an author actually checks. No GFM
	 * preset is loaded at all, which is what keeps tables out (P3.24).
	 */
	function subsetOnly(preset: Preset): Plugins {
		// Built in one pass rather than filled with `add`, because eslint reads a
		// mutated `Set` as reactive state and asks for `SvelteSet`; this one is a
		// local lookup table that never outlives the call.
		const excluded = new Set<unknown>(
			Object.entries(preset as Record<string, unknown>)
				.filter(([key]) => EXCLUDED_NODES.some((node) => key.toLowerCase().includes(node)))
				.flatMap(([, plugin]) =>
					Array.isArray(plugin) ? (plugin.flat(Infinity) as unknown[]) : [plugin]
				)
		);

		// Cast rather than typed: `commonmark` is declared as a union array that
		// includes `sanitizeLinkHref`, a plain `(href) => string`, so the preset's
		// own type is not assignable to the `use` it exists to be passed to —
		// filter or no filter.
		const plugins = preset.commonmark as unknown as unknown[];
		return plugins.filter((plugin) => !excluded.has(plugin)) as Plugins;
	}

	/**
	 * `markdownUpdated` is debounced — measured empty a whole animation frame
	 * after a keystroke — so a save clicked straight after typing posts the
	 * document as it was before, and the save reports success over a body nobody
	 * wrote. §16 named this as the hazard of putting ProseMirror over a form
	 * field: it does not fail, it loses the last edit quietly.
	 *
	 * Serialising at submit time closes it. The listener is on `document` in the
	 * capture phase because `use:enhance` registers its own submit handler on the
	 * form while this component is still waiting for its dynamic imports — a
	 * listener added to the form later would run after enhance had already read
	 * the field.
	 */
	function syncBeforeSubmit(event: Event): void {
		if (!field || event.target !== field.form || !readMarkdown) return;
		if (writtenFromOutside) return;

		markdown = readMarkdown();
		field.value = markdown;
	}

	onMount(() => {
		void mount();
		document.addEventListener('submit', syncBeforeSubmit, true);

		return () => {
			document.removeEventListener('submit', syncBeforeSubmit, true);
			void editor?.destroy();
		};
	});
</script>

{#if readonly}
	<textarea
		data-testid={testId}
		{name}
		readonly
		rows="8"
		class="w-full rounded border px-2 py-1 font-mono">{markdown}</textarea
	>
{:else}
	<div bind:this={host} data-testid="{testId}-editor" class="rounded border px-2 py-1"></div>
	<!-- Hidden, not absent: this is the field the form posts, and the editor is
	     a view over it. -->
	<textarea
		bind:this={field}
		data-testid={testId}
		{name}
		hidden
		bind:value={markdown}
		oninput={() => (writtenFromOutside = true)}></textarea>
{/if}
```

If Step 1 printed different export names, use those. If Step 2 concluded the filter is impractical, replace `subsetOnly(commonmark)` with `commonmark.commonmark as never` and note it in the commit message.

Three things the draft above got wrong, all found by compiling it:

- `nord` is a config function, not a plugin — `.config(nord)`, never `.use(nord)` — and its stylesheet is a separate entry the theme does not pull in itself. Without that stylesheet Tailwind's reset leaves a heading looking like body text inside the editor, which is the one place an author is judging structure.
- Excluding only the six `*Schema` exports is not enough. Every node also ships input rules and commands (`wrapInBlockquoteInputRule`, `insertImageInputRule`, `createCodeBlockInputRule`, `toggleLinkCommand`, and so on) which are created eagerly and look their node type up in the schema; keeping one whose schema is gone throws at `create()`, and a throw there is a blank editor with no message. Matching the preset's export names against a node-name token takes all of them.
- The `never` casts are not needed and hide the one place a cast is honest: `commonmark` is declared as a union array including `sanitizeLinkHref`, a plain `(href) => string`, so the preset's own type is not assignable to the `use` it exists to be passed to. Everything else types cleanly, `host` wants `$state()` for `bind:this`, and `$state(value)` wants the same `svelte-ignore` Task 8 uses.

- [x] **Step 4: Verify it compiles and nothing public grew**

```sh
pnpm check
pnpm build
node -e "
const { readdirSync, readFileSync } = require('node:fs');
const dir = '.svelte-kit/output/client/_app/immutable/entry';
const hit = readdirSync(dir).filter((f) => readFileSync(dir + '/' + f, 'utf8').includes('milkdown'));
console.log(hit.length === 0 ? 'ok: milkdown is not in an entry chunk' : 'LEAK: ' + hit.join(' '));
"
```

Expected: 0 errors, 0 warnings; the build succeeds; the check prints `ok`. If it prints `LEAK`, the import is not dynamic enough — find the static import and remove it before continuing. If the entry directory has a different name in the installed SvelteKit, adjust the path; the assertion is what matters.

- [x] **Step 5: Commit**

```sh
pnpm format
git add package.json pnpm-lock.yaml src/lib/components/admin/MarkdownEditor.svelte
git commit -m "feat(admin): a markdown editor over a hidden textarea"
```

---

### Task 10: Put the editor on the version page, keeping the preview

Milkdown replaces the textarea. The server-rendered `AgreementBody` preview stays below it (P3.24, §5.4): the editor draws its own ProseMirror document while the preview draws the AST `parseAgreementBody` returned from the server, and having both on the page is what shows they still agree. A WYSIWYG surface also cannot show what the server *refused*, which is the case the preview exists for.

**Files:**
- Modify: `src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.svelte`

**Interfaces:**
- Consumes: `MarkdownEditor` from Task 9 and its `setMarkdown` method; the `?/import` result from Task 7.
- Produces: no new test ids — `body-{locale}` moves onto the hidden textarea so existing assertions keep working.

- [x] **Step 1: Swap the textarea for the editor**

In the `.svelte` script, add the import and a place to hold the instances:

```ts
	import MarkdownEditor from '$lib/components/admin/MarkdownEditor.svelte';

	// One handle per locale so an import result can be pushed into the right
	// editor. `bind:this` on a keyed each is how a parent reaches a child
	// instance in runes mode; the record is state so the binding survives a
	// form action's data invalidation.
	let editors: Record<string, { setMarkdown: (markdown: string) => void }> = $state({});
```

Replace the `bodies` state effect from Task 8's Step 4 — the editor now owns the value, and the page only pushes imports into it:

```ts
	$effect(() => {
		const imported = form && 'imported' in form ? form.imported : null;
		if (imported) editors[imported.locale]?.setMarkdown(imported.markdown);
	});
```

Replace the `<textarea>` inside the `FormField` with:

```svelte
				<MarkdownEditor
					bind:this={editors[locale]}
					name="body.{locale}"
					testId="body-{locale}"
					value={data.bodies[locale]?.bodyMd ?? ''}
					readonly={immutable}
				/>
```

Leave the preview block exactly as it is.

- [x] **Step 2: Give the specs a way to write a body**

Nine call sites across `admin-agreements.spec.ts` and `tests/helpers/admin.ts` do `page.getByTestId('body-de').fill(...)`, and `fill` refuses a hidden element — every one of them breaks the moment the textarea is hidden. Add a helper beside `draftVersion` and route them through it:

```ts
export async function fillBody(page: Page, locale: string, markdown: string) {
	await page.getByTestId(`body-${locale}`).evaluate((node, value) => {
		const field = node as HTMLTextAreaElement;
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	}, markdown);
}
```

Writing the posted field directly is right for these cases: their subject is the server — validation, publication, persistence — and it is also what a paste of raw Markdown or a client with the editor disabled produces. What it does *not* cover is the editor's own keystroke path, which is exactly what Task 11's first case exists to prove, so the two are complementary rather than the helper being a way around the editor.

- [x] **Step 3: Verify the page still compiles and the old assertions still hold**

```sh
pnpm check
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app
```

Expected: 0 errors, 0 warnings; the spec passes. Task 8's import case asserts `body-de`'s **value**, which now lives on the hidden textarea — `toHaveValue` reads a hidden field without complaint, and it passing is what shows the import reached the editor and the editor reached the field.

- [x] **Step 4: Commit**

```sh
pnpm format
git add "src/routes/(admin)/admin/agreements/[id]/versions/[versionId]/+page.svelte" tests/helpers/admin.ts tests/e2e/admin-agreements.spec.ts
git commit -m "feat(admin): author an agreement body in a wysiwyg editor"
```

---

### Task 11: Prove the editor writes what gets saved — Gate 2

The failure §16 names is silent: a lost keystroke produces a passing test over a body that was never written. So the case that matters is not "the editor renders" but "what a person typed reached the database".

**Files:**
- Test: `tests/e2e/admin-agreements.spec.ts`

- [x] **Step 1: Write the failing e2e case**

```ts
test('saves what was typed in the editor, and previews it from the server', async ({ page }) => {
	const versionUrl = await draftVersion(page);
	await page.goto(versionUrl);
	await awaitHydration(page);

	const typed = `Geheimhaltung ${Date.now()}`;
	await page.getByTestId('body-de-editor').click();
	await page.keyboard.type(typed);

	await submitAndWait(page, 'version-save', '?/saveBody');
	await page.reload();
	await awaitHydration(page);

	// The server parsed it and rendered it back: the preview is the control
	// (§5.4), and it drawing the text is what proves the editor's document
	// reached the field the form posted.
	await expect(page.getByTestId('agreement-body').first()).toContainText(typed);

	// §14 asks for the journey through to publication, because a body that
	// saves but cannot be published is a body nobody can be asked to sign.
	// Fill every enabled locale first — a version is effective only when all of
	// them have a body (§5.2).
	for (const locale of ['en']) {
		await page.getByTestId(`body-${locale}-editor`).click();
		await page.keyboard.type(typed);
	}
	await submitAndWait(page, 'version-save', '?/saveBody');
	await submitAndWait(page, 'version-publish', '?/publish');
	await expect(page.getByTestId('version-status')).toContainText(/effective|wirksam/i);
});

test('refuses an import into a version somebody has already accepted', async ({ page }) => {
	// The immutability guard is the server's, and the disabled control in the UI
	// is only a courtesy — so this posts straight at the action. `page.request`
	// carries the signed-in staff cookie, and a `fail()` from a non-enhanced
	// POST re-renders the page with its status.
	const { versionUrl, acceptedVersionUrl } = await acceptedVersion(page);

	const response = await page.request.post(`${acceptedVersionUrl}?/import`, {
		multipart: {
			locale: 'de',
			file: {
				name: 'nda.docx',
				mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				buffer: Buffer.from(docxWith([{ text: 'Neuer Text.' }]))
			}
		}
	});

	expect(response.status()).toBe(409);
	expect(versionUrl).toBeTruthy();
});

test('reports a node the server refuses, which the editor cannot show', async ({ page }) => {
	const versionUrl = await draftVersion(page);
	await page.goto(versionUrl);
	await awaitHydration(page);

	// Straight into the hidden field, which is what a paste of raw Markdown or a
	// client with the editor disabled produces. §5.1: the client schema is a
	// convenience, the server refusal is the control.
	await page.getByTestId('body-de').evaluate((node, value) => {
		const field = node as HTMLTextAreaElement;
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	}, '| a | b |\n| - | - |\n\n![x](https://example.test/x.png)');

	await submitAndWait(page, 'version-save', '?/saveBody');
	await expect(page.getByTestId('body-not-in-subset')).toBeVisible();
});
```

`acceptedVersion(page)` does not exist and does not need to. A version becomes immutable only once somebody has accepted it, and `tests/e2e/nda-journey.spec.ts` already drives a full acceptance — put that case **in that file**, reusing `seedRequestForAgreement` plus the journey's own approve-and-accept steps, and look the template and version up by slug in the database rather than clicking through the admin pages to find their ids.

Two things about the POST itself:

- `page.request.post` sends no `Origin`, and SvelteKit's CSRF check refuses a form POST without one. Pass `headers: { origin: new URL(page.url()).origin }`.
- The response is **HTTP 200 carrying an ActionResult envelope**, not a 409: `{"type":"failure","status":409,"data":"…"}`. Assert the envelope's `status` and that its `data` names `immutable`, so the case cannot pass on any other 4xx.

- [x] **Step 2: Run them**

```sh
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app
pnpm test:e2e tests/e2e/nda-journey.spec.ts --project=app
```

Expected: PASS. The first case **does** fail on the draft component, with an empty body, and that is the §16 hazard rather than a test bug — do not add a wait to the test.

Writing `markdown` on every `markdownUpdated` is not the fix, because `markdownUpdated` is itself debounced: measured against milkdown 7.22, the hidden field is still empty a full animation frame after a keystroke, so a save clicked straight after typing posts the document as it was before and reports success over a body nobody wrote. The fix is to serialise the live document at submit time, from a `submit` listener on `document` in the **capture** phase — `use:enhance` registers its own handler on the form while the component is still awaiting its dynamic imports, so a listener added to the form later runs after enhance has already read the field.

That sync then has to yield to an external write, or it clobbers `fillBody` and the third case below: an `input` event on a hidden textarea cannot come from a person, since Svelte's binding writes the property without dispatching one, so the only source is script — a paste of raw Markdown, or a client with the editor disabled. Whoever wrote last owns the value.

If the second case passes for the wrong reason — the editor stripped the table rather than the server refusing it — assert the server's message text as well, so the case cannot pass without the refusal.

- [x] **Step 3: Check the console is clean under CSP**

The portal's CSP runs in `auto` mode with no third-party origins, and a ProseMirror integration is the first thing in this codebase to build DOM at runtime. Add a console listener to the first case temporarily and confirm no `Content Security Policy` violation is logged:

```sh
pnpm test:e2e tests/e2e/admin-agreements.spec.ts --project=app -t 'saves what was typed' --debug
```

If a violation appears, do **not** widen the CSP in `vite.config.ts`. Find the inline style or script the editor is injecting and configure it away; the no-third-party-origin posture is asserted permanently in `tests/e2e/security.spec.ts` and is a product claim (§3.5).

Measured: the editor introduces none. Two `style-src-attr` violations do fire, and both are already there on `/de/admin`, `/de/admin/agreements` and `/de/admin/documents` with no editor on the page — a `style="display: contents"` wrapper in the layout and SvelteKit's own visually-hidden announcer element. They are outside this phase; record them in the carry-over rather than widening anything.

- [x] **Step 4: Commit and gate**

```sh
pnpm format
git add tests/e2e/admin-agreements.spec.ts
git commit -m "test(e2e): prove the editor's document reaches the saved body"
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. **Gate 2** — the editor theme is complete. If the phase is running long, this is a defensible place to stop and carry the remaining two themes forward.

---

### Task 12: Keep every locale pane mounted

`LocaleTabs` renders only the active locale (`{#if locale === active}`). That is correct for six separate one-locale forms and **silently destructive** for one multi-locale form: an unmounted pane's inputs are not in the DOM, so the browser posts nothing for them, and switching tabs before saving would blank every locale the author did not have open.

This is the first task of the consolidation theme because every task after it depends on the panes being present.

**Files:**
- Modify: `src/lib/components/admin/LocaleTabs.svelte`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged props; the only change is that all panes exist in the DOM and inactive ones carry the `hidden` attribute.

- [x] **Step 1: Keep the panes, hide the inactive ones**

Replace the final block of `src/lib/components/admin/LocaleTabs.svelte`:

```svelte
{#each locales as locale (locale)}
	<!-- Every pane stays mounted, and only visibility changes. Rendering just
	     the active one was right while each locale had its own form; with one
	     form spanning every locale, an unmounted pane posts no fields at all and
	     saving would blank the locales nobody had opened. -->
	<div hidden={locale !== active}>{@render children(locale)}</div>
{/each}
```

- [x] **Step 2: Verify nothing that used tabs regressed**

```sh
pnpm check
pnpm test:e2e tests/e2e/admin-content.spec.ts --project=app
```

Expected: 0 errors, 0 warnings; the spec passes unchanged — at this point every editor still posts one locale at a time, so this change is invisible to them. If a case now finds two elements with the same test id, that is the point of the change: the spec must scope its lookup to the visible pane, and Tasks 14–19 rewrite those cases anyway.

- [x] **Step 3: Commit**

```sh
pnpm format
git add src/lib/components/admin/LocaleTabs.svelte
git commit -m "fix(admin): keep every locale pane mounted, hide the inactive ones"
```

---

### Task 13: `saveTranslationsAction`

`saveMetaAction` has generalised on first contact for three phases running. Its translation counterpart has not, for one reason: `saveTranslationAction` writes **one locale per POST**, and every content type added since Phase 1 submits all locales at once, so five call sites hand-roll the multi-locale version instead.

This adds the plural helper in the shape `saveMetaAction` established, with the form-reading half split out as a pure function so it can be unit-tested the way the other pure helpers in this module are.

**Files:**
- Modify: `src/lib/server/admin/actions.ts`
- Test: `tests/unit/admin-actions.test.ts`

**Interfaces:**
- Consumes: `saveTranslationsFromForm` is **not** used — this replaces it for these call sites; `getConfig`, `getDb`, `recordEvent`, `translationAction`.
- Produces:
  - `readTranslations(form: FormData, locales: readonly string[], opts: { required: readonly string[]; optional?: readonly string[] }): { values: Map<string, Record<string, string | null>> } | { missing: { field: string; locale: string } }`
  - `saveTranslationsAction(opts: SaveTranslationsOptions)` where `SaveTranslationsOptions` is `{ type: string; subjectType?: string; required: readonly string[]; optional?: readonly string[]; set: (db: Db, id: string, locale: string, values: Record<string, string | null>) => Promise<unknown> }`

- [x] **Step 1: Write the failing unit tests**

Append to `tests/unit/admin-actions.test.ts`:

```ts
import { readTranslations } from '../../src/lib/server/admin/actions';

describe('readTranslations', () => {
	const opts = { required: ['question', 'answer'], optional: ['note'] };

	function formOf(entries: Record<string, string>): FormData {
		const form = new FormData();
		for (const [key, value] of Object.entries(entries)) form.append(key, value);
		return form;
	}

	it('reads one locale per field suffix', () => {
		const result = readTranslations(
			formOf({ 'question.de': 'Frage', 'answer.de': 'Antwort' }),
			['de', 'en'],
			opts
		);

		expect('values' in result && result.values.get('de')).toEqual({
			question: 'Frage',
			answer: 'Antwort',
			note: null
		});
	});

	it('skips a locale nobody translated rather than failing on it', () => {
		// The "not translated" state is normal and visible in the tab strip; a
		// form that refused to save because one locale is blank would make
		// translating a document a single transaction across every language.
		const result = readTranslations(
			formOf({ 'question.de': 'Frage', 'answer.de': 'Antwort' }),
			['de', 'en'],
			opts
		);

		expect('values' in result && result.values.has('en')).toBe(false);
	});

	it('reports a locale filled in only halfway, naming the field and the locale', () => {
		const result = readTranslations(formOf({ 'question.de': 'Frage' }), ['de'], opts);

		expect(result).toEqual({ missing: { field: 'answer', locale: 'de' } });
	});

	it('stores an empty optional field as null', () => {
		const result = readTranslations(
			formOf({ 'question.de': 'F', 'answer.de': 'A', 'note.de': '  ' }),
			['de'],
			opts
		);

		expect('values' in result && result.values.get('de')?.note).toBeNull();
	});
});
```

- [x] **Step 2: Run them to verify they fail**

```sh
pnpm test:unit tests/unit/admin-actions.test.ts -t readTranslations
```

Expected: FAIL — `readTranslations` is not exported.

- [x] **Step 3: Write the reader and the action**

Append to `src/lib/server/admin/actions.ts`:

```ts
interface SaveTranslationsOptions {
	type: string;
	subjectType?: string;
	/** Trimmed and required. Order defines which is reported first on failure. */
	required: readonly string[];
	/** Trimmed, and empty means `null` rather than a validation failure. */
	optional?: readonly string[];
	set: (
		db: Db,
		id: string,
		locale: string,
		values: Record<string, string | null>
	) => Promise<unknown>;
}

/**
 * Reads `field.<locale>` out of a multi-locale form, for every enabled locale.
 *
 * A locale with none of its required fields filled in is **skipped**, not
 * refused: "not translated" is a normal state the tab strip already marks, and
 * refusing the save would make translating one page a single transaction across
 * every language. A locale filled in halfway is refused, naming both the field
 * and the locale, because that one is a mistake rather than a state.
 *
 * Pure, and separate from the action, so it is testable without a database —
 * the same split `proposeFrom` uses for the same reason.
 */
export function readTranslations(
	form: FormData,
	locales: readonly string[],
	opts: { required: readonly string[]; optional?: readonly string[] }
): { values: Map<string, Record<string, string | null>> } | { missing: AdminActionFailure } {
	const values = new Map<string, Record<string, string | null>>();

	for (const locale of locales) {
		const read = (field: string): string =>
			String(form.get(`${field}.${locale}`) ?? '')
				.trim();

		if (opts.required.every((field) => read(field).length === 0)) continue;

		const entry: Record<string, string | null> = {};

		for (const field of opts.required) {
			const value = read(field);
			if (!value) return { missing: { field, locale } };
			entry[field] = value;
		}

		for (const field of opts.optional ?? []) entry[field] = read(field) || null;

		values.set(locale, entry);
	}

	return { values };
}

/**
 * The plural counterpart to `saveMetaAction`, for editors whose form submits
 * every locale at once — which is every content type added since Phase 1.
 *
 * `saveTranslationAction` (singular) writes one locale per POST and is what the
 * six Phase 1 editors used; §20 records why the two shapes coexisted and why
 * this one wins. One audit event per save, carrying the locales written, which
 * is the shape the group and agreement editors already record.
 */
export function saveTranslationsAction(opts: SaveTranslationsOptions) {
	return async (event: AdminEvent) => {
		const form = await event.request.formData();
		const read = readTranslations(form, getConfig().locales, opts);

		if ('missing' in read) return fail<AdminActionFailure>(400, read.missing);

		const db = getDb();
		const written: string[] = [];

		for (const [locale, values] of read.values) {
			await opts.set(db, event.params.id, locale, values);
			written.push(locale);
		}

		await recordEvent(db, {
			action: translationAction(opts.type),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: opts.subjectType ?? opts.type,
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { locales: written }
		});

		return { saved: true };
	};
}
```

- [x] **Step 4: Run the tests to verify they pass**

```sh
pnpm test:unit tests/unit/admin-actions.test.ts
pnpm check
```

Expected: PASS; 0 errors, 0 warnings.

- [x] **Step 5: Commit**

```sh
pnpm format
git add src/lib/server/admin/actions.ts tests/unit/admin-actions.test.ts
git commit -m "feat(admin): one action for a form that submits every locale"
```

---

### Tasks 14–19: Move the six editors onto the multi-locale form

Six editors, one shape. Each is its own task and its own commit, so a reviewer can reject one without rejecting the rest, and each ends with its e2e case passing.

**The shape, identical in all six.** In `+page.server.ts`: rename the action key from `saveTranslation` to `saveTranslations`, swap `saveTranslationAction` for `saveTranslationsAction` in the import and the call, and leave `type`, `subjectType`, `required`, `optional` and `set` exactly as they are — the options are the same and that is the point.

In `+page.svelte`: wrap `<LocaleTabs>` in one form posting to `?/saveTranslations`, suffix every input name with `.{locale}`, drop the `<input type="hidden" name="locale">`, and move the save button outside the tabs so there is one. Field test ids keep their `-{locale}` suffix; the button becomes `translation-save`, without one.

In the e2e: replace `submitAndWait(page, 'translation-save-de', '?/saveTranslation')` with `submitAndWait(page, 'translation-save', '?/saveTranslations')`. Where a case fills one locale and asserts the other is untranslated, it still works — `readTranslations` skips a locale whose required fields are all empty.

**Per task:**

| Task | Editor | `type` | required | optional | e2e |
| --- | --- | --- | --- | --- | --- |
| 14 | `admin/faq/[id]` | `answer` | `question`, `answer` | — | `admin-content.spec.ts:98` |
| 15 | `admin/subprocessors/[id]` | `subprocessor` | `purpose`, `dataCategories` | — | `admin-content.spec.ts:74` |
| 16 | `admin/updates/[id]` | `update` (subject `update_post`) | `title`, `body` | — | `admin-content.spec.ts:125` |
| 17 | `admin/controls/[id]` | `control` | `title` | `description` | `admin-content.spec.ts:24` |
| 18 | `admin/certifications/[id]` | `certification` | `scope` | — | `admin-content.spec.ts:48` |
| 19 | `admin/documents/[id]` | `document` | `title` | `summary` | `admin-documents.spec.ts:26` |

The line numbers above are corrected: the original table numbered the cases in
task order, but `admin-content.spec.ts` orders them control, certification,
subprocessor, answer, update. Match the case by its `test(...)` name, not by the
line — Tasks 14–19 each shift the ones below them.

- [x] **Step 1 (Task 14): Change the FAQ editor's action**

In `src/routes/(admin)/admin/faq/[id]/+page.server.ts`:

```ts
import { saveMetaAction, saveTranslationsAction } from '$lib/server/admin/actions';
```

```ts
	saveTranslations: saveTranslationsAction({
		type: 'answer',
		required: ['question', 'answer'],
		set: (db, id, locale, values) =>
			setAnswerTranslation(db, id, locale, {
				question: values.question!,
				answer: values.answer!
			})
	}),
```

- [x] **Step 2 (Task 14): Change the FAQ editor's form**

In `src/routes/(admin)/admin/faq/[id]/+page.svelte`, replace the whole `<LocaleTabs>` block with:

```svelte
<form method="POST" action="?/saveTranslations" use:enhance class="mb-8">
	<LocaleTabs
		locales={data.locales}
		initial={data.locale}
		translated={(locale) => translationFor(locale) !== null}
	>
		{#snippet children(locale)}
			<div class="grid gap-3 rounded border bg-white p-4">
				<FormField label={m.admin_question()}>
					<input
						data-testid="translation-question-{locale}"
						name="question.{locale}"
						value={translationFor(locale)?.question ?? ''}
						placeholder={m.admin_not_translated()}
						class="rounded border px-2 py-1"
					/>
				</FormField>

				<FormField label={m.admin_answer()}>
					<textarea
						data-testid="translation-answer-{locale}"
						name="answer.{locale}"
						rows="5"
						class="rounded border px-2 py-1">{translationFor(locale)?.answer ?? ''}</textarea
					>
				</FormField>

				{#if (form?.field === 'question' || form?.field === 'answer') && form?.locale === locale}
					<p class="text-sm text-red-700">{m.admin_error_required()}</p>
				{/if}
			</div>
		{/snippet}
	</LocaleTabs>

	<button
		data-testid="translation-save"
		class="mt-3 justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_save()}
	</button>
</form>
```

- [x] **Step 3 (Task 14): Update the e2e case and run it**

In `tests/e2e/admin-content.spec.ts:24`, change the FAQ case's submit to:

```ts
	await submitAndWait(page, 'translation-save', '?/saveTranslations');
```

```sh
pnpm test:e2e tests/e2e/admin-content.spec.ts --project=app
```

Expected: the FAQ case passes; the other four still pass, unchanged.

- [x] **Step 4 (Task 14): Commit**

```sh
pnpm format
git add "src/routes/(admin)/admin/faq/[id]" tests/e2e/admin-content.spec.ts
git commit -m "refactor(admin): submit every faq locale in one form"
```

- [x] **Steps 5–8 (Task 15): the subprocessor editor**

Same four steps against `src/routes/(admin)/admin/subprocessors/[id]/`. The action becomes:

```ts
	saveTranslations: saveTranslationsAction({
		type: 'subprocessor',
		required: ['purpose', 'dataCategories'],
		set: (db, id, locale, values) =>
			setSubprocessorTranslation(db, id, locale, {
				purpose: values.purpose!,
				dataCategories: values.dataCategories!
			})
	}),
```

The two inputs become `name="purpose.{locale}"` and `name="dataCategories.{locale}"`, keeping their existing test ids and labels. The e2e change is at `admin-content.spec.ts:74`. Commit as `refactor(admin): submit every subprocessor locale in one form`.

- [x] **Steps 9–12 (Task 16): the updates editor**

Against `src/routes/(admin)/admin/updates/[id]/`. Note `subjectType` — dropping it would silently rewrite the audit subject of every future row:

```ts
	saveTranslations: saveTranslationsAction({
		type: 'update',
		subjectType: 'update_post',
		required: ['title', 'body'],
		set: (db, id, locale, values) =>
			setUpdateTranslation(db, id, locale, { title: values.title!, body: values.body! })
	}),
```

Inputs become `title.{locale}` and `body.{locale}`. The e2e change is at `admin-content.spec.ts:125`. Commit as `refactor(admin): submit every update locale in one form`.

- [ ] **Steps 13–16 (Task 17): the controls editor**

Against `src/routes/(admin)/admin/controls/[id]/`. This one has an optional field, so a locale carrying only a description and no title is a half-filled locale and must be refused — which `readTranslations` does, naming `title`:

```ts
	saveTranslations: saveTranslationsAction({
		type: 'control',
		required: ['title'],
		optional: ['description'],
		set: (db, id, locale, values) =>
			setControlTranslation(db, id, locale, {
				title: values.title!,
				description: values.description ?? null
			})
	}),
```

Inputs become `title.{locale}` and `description.{locale}`. The e2e change is at `admin-content.spec.ts:24`. Commit as `refactor(admin): submit every control locale in one form`.

- [ ] **Steps 17–20 (Task 18): the certifications editor**

Against `src/routes/(admin)/admin/certifications/[id]/`:

```ts
	saveTranslations: saveTranslationsAction({
		type: 'certification',
		required: ['scope'],
		set: (db, id, locale, values) =>
			setCertificationTranslation(db, id, locale, { scope: values.scope! })
	}),
```

The input becomes `scope.{locale}`. The e2e change is at `admin-content.spec.ts:48`. Commit as `refactor(admin): submit every certification locale in one form`.

- [ ] **Steps 21–24 (Task 19): the documents editor**

Against `src/routes/(admin)/admin/documents/[id]/`. This page also carries the file upload and the status form; leave both untouched — only the translation block moves:

```ts
	saveTranslations: saveTranslationsAction({
		type: 'document',
		required: ['title'],
		optional: ['summary'],
		set: (db, id, locale, values) =>
			setDocumentTranslation(db, id, locale, {
				title: values.title!,
				summary: values.summary ?? null
			})
	}),
```

Inputs become `title.{locale}` and `summary.{locale}`. The e2e change is at `admin-documents.spec.ts:26`, where the click becomes:

```ts
	await page.getByTestId('translation-save').click();
```

```sh
pnpm test:e2e tests/e2e/admin-documents.spec.ts --project=app
pnpm test:e2e tests/e2e/admin-upload.spec.ts --project=app
```

Both must pass — `admin-upload.spec.ts` drives the same page. Commit as `refactor(admin): submit every document locale in one form`.

---

### Task 20: Delete `saveTranslationAction` — Gate 3

Now, and not before: §19 recorded this helper as unused and folded its deletion into 3b, which found six callers and skipped the step. With those six moved, the claim is finally true, and §20 records the correction rather than letting the original assertion stand.

**Files:**
- Modify: `src/lib/server/admin/actions.ts`

- [ ] **Step 1: Confirm there is no caller left**

```sh
grep -rn "saveTranslationAction\|?/saveTranslation\b" src tests
```

Expected: only the definition in `src/lib/server/admin/actions.ts`. If anything else appears, that call site was missed — migrate it before deleting, exactly as Tasks 14–19 did. Do not delete around a live caller.

- [ ] **Step 2: Delete the helper and its options interface**

Remove `SaveTranslationOptions` and `saveTranslationAction` from `src/lib/server/admin/actions.ts`. Leave `translationAction` — it names the audit action and both helpers used it.

- [ ] **Step 3: Verify**

```sh
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green, 0 errors, 0 warnings. **Gate 3** — the consolidation theme is complete.

- [ ] **Step 4: Commit**

```sh
pnpm format
git add src/lib/server/admin/actions.ts
git commit -m "refactor(admin): drop the one-locale-per-post translation helper"
```

---

### Task 21: Make the delivery probe free

`narrowByAgreements` runs five queries — four in parallel plus `requirementsByDocument` — before it can discover that nothing in the set carries an agreement, which is the state every deployment is in until an operator configures one. Both callers already join `document`; folding `document.tier` and the two group joins into **that** select answers the question from data the join already had.

The rule stays `proposeFrom`, the same one the approver's proposal uses. That is deliberate and unchanged: `domainIsRuleMatched`'s comment warns that a second expression of an access rule in SQL will drift, and 3b's carry-over records the SQL-pre-check-plus-JS-call design this task extends rather than replaces.

**This may only remove rows, never add one.** `nda-delivery.test.ts` owns that invariant; it must pass untouched.

**Files:**
- Modify: `src/lib/server/access/grants.ts`
- Test: `tests/integration/nda-delivery.test.ts`, `tests/integration/grants-scope.test.ts` (must pass unchanged)

**Interfaces:**
- Consumes: `proposeFrom`, `DefaultTemplateMissing` from `src/lib/server/nda/requirements.ts`; `documentGroup`, `accessGroup` from the schema.
- Produces: `ConferredRow` gains `tier: string` and `groupTemplateIds: (string | null)[]`. `requirementsByDocument` loses its only caller but stays exported — it is the read `proposeRequirements` is built on.

- [ ] **Step 1: Record the query count before changing anything**

```sh
pnpm test:integration tests/integration/nda-delivery.test.ts
pnpm test:integration tests/integration/grants-scope.test.ts
```

Both must be green before you start; this task is judged on them still being green afterwards.

- [ ] **Step 2: Widen the conferred select**

In `src/lib/server/access/grants.ts`, add the imports:

```ts
import { DefaultTemplateMissing, proposeFrom } from '../nda/requirements';
import { accessGroup, documentGroup } from '../db/schema';
```

Extend `ConferredRow` and add the fold:

```ts
/** One (grant, document) pair the scope query conferred, before the live re-check. */
interface ConferredRow {
	grantId: string;
	requesterId: string;
	documentId: string;
	expiresAt: Date | null;
	tier: string;
	/** One entry per group the document belongs to; `null` where that group carries no agreement. */
	groupTemplateIds: (string | null)[];
}

/**
 * The select both callers run. The two left joins are what make the delivery
 * re-check free in the common case: `narrowByAgreements` used to ask
 * `requirementsByDocument` before it could know the answer was "nothing is
 * gated", so every gated download and every portal list paid a round trip to
 * learn the state a deployment is in until an operator configures an agreement.
 *
 * The joins multiply a document by its group memberships, which is why the rows
 * fold back into one entry per (grant, document) — the same shape
 * `scopedDocuments` folds into, for the same reason.
 */
function conferredSelect(db: Db, where: SQL | undefined) {
	return db
		.select({
			grantId: accessGrant.id,
			requesterId: accessGrant.requesterId,
			documentId: document.id,
			expiresAt: accessGrant.expiresAt,
			tier: document.tier,
			groupTemplateId: accessGroup.ndaTemplateId
		})
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.leftJoin(documentGroup, eq(documentGroup.documentId, document.id))
		.leftJoin(accessGroup, eq(accessGroup.id, documentGroup.groupId))
		.where(where);
}

function foldConferred(
	rows: readonly {
		grantId: string;
		requesterId: string;
		documentId: string;
		expiresAt: Date | null;
		tier: string;
		groupTemplateId: string | null;
	}[]
): ConferredRow[] {
	const folded = new Map<string, ConferredRow>();

	for (const row of rows) {
		const key = `${row.grantId}:${row.documentId}`;
		const seen = folded.get(key);

		if (seen) {
			seen.groupTemplateIds.push(row.groupTemplateId);
			continue;
		}

		folded.set(key, {
			grantId: row.grantId,
			requesterId: row.requesterId,
			documentId: row.documentId,
			expiresAt: row.expiresAt,
			tier: row.tier,
			groupTemplateIds: [row.groupTemplateId]
		});
	}

	return [...folded.values()];
}
```

Point `grantedDocuments` at it:

```ts
	const conferred = foldConferred(
		await conferredSelect(
			db,
			and(
				eq(accessGrant.requesterId, requesterId),
				options.documentId ? eq(document.id, options.documentId) : undefined
			)
		)
	);
```

- [ ] **Step 3: Answer the probe from the rows**

Replace the head of `narrowByAgreements`, up to and including the `unresolvable.size === 0` early return, with:

```ts
	if (rows.length === 0) return [];

	// Free: the join already told us. Nothing at the `nda` tier and no group
	// carrying an agreement means nothing here is gated, which is every
	// deployment until an operator configures one. This used to cost five
	// queries to discover.
	const gated = rows.some(
		(row) => row.tier === 'nda' || row.groupTemplateIds.some((id) => id !== null)
	);
	if (!gated) return [...rows];

	// These four are independent of each other, and this is the gated download
	// path — they go together rather than one round trip at a time.
	const [defaultTemplate, waivers, scope, people] = await Promise.all([
		defaultTemplateId(db),
		db
			.select({ grantId: accessGrantNda.grantId, templateId: accessGrantNda.ndaTemplateId })
			.from(accessGrantNda)
			.where(
				and(
					inArray(
						accessGrantNda.grantId,
						rows.map((row) => row.grantId)
					),
					eq(accessGrantNda.disposition, 'waived')
				)
			),
		acceptanceScope(db),
		db
			.select({ id: requester.id, companyDomain: requester.companyDomain })
			.from(requester)
			.where(inArray(requester.id, [...new Set(rows.map((row) => row.requesterId))]))
	]);

	// `proposeFrom` rather than `requirementsByDocument`: the read that helper
	// performs is now the join above, and the rule itself is the one the
	// approver's proposal used. Restating it here would be the second
	// implementation `domainIsRuleMatched`'s comment warns about.
	const required = new Map<string, string[]>();
	const unresolvable = new Set<string>();

	for (const row of rows) {
		try {
			required.set(
				row.documentId,
				proposeFrom([{ id: row.documentId, tier: row.tier, groupTemplateIds: row.groupTemplateIds }], {
					defaultTemplateId: defaultTemplate
				})
			);
		} catch (cause) {
			// §4.4 fails closed: an `nda`-tier document with no default agreement
			// is undeliverable, not ungated.
			if (!(cause instanceof DefaultTemplateMissing)) throw cause;
			unresolvable.add(row.documentId);
		}
	}
```

Everything below that — the waived set, the `holds` cache, the delivery loop — stays exactly as it is.

If `ScopedDocument` is not exported from `requirements.ts`, export it; the object literal above must be the same type `proposeFrom` takes, not a structurally similar one.

- [ ] **Step 4: Verify the invariant survived**

```sh
pnpm test:integration tests/integration/nda-delivery.test.ts
pnpm test:integration tests/integration/grants-scope.test.ts
pnpm test:integration
```

Expected: PASS, unchanged. These tests are the control on this task: if the narrowing-only case fails, the fold lost a group membership and a document that should be gated is being delivered — stop and fix, do not adjust the test.

- [ ] **Step 5: Commit**

```sh
pnpm format
git add src/lib/server/access/grants.ts src/lib/server/nda/requirements.ts
git commit -m "perf(access): answer the delivery probe from the join that already ran"
```

---

### Task 22: Let `countGrantDocuments` count again

It asked Postgres for `count(*)::int` until 3b, when it began shipping one (grant, document) row per conferred document so the delivery filter could narrow them. For a tier-wide grant that is the whole catalogue over the wire to produce an integer, once per due grant in a six-hourly job.

Task 21 made the "is anything gated here" question answerable in SQL, so the aggregate can come back for the case where narrowing cannot remove anything.

**Files:**
- Modify: `src/lib/server/access/grants.ts`
- Test: `tests/integration/expiry.test.ts`, `tests/integration/nda-grants.test.ts` (must pass unchanged)

- [ ] **Step 1: Ask the cheap question first**

Replace the body of `countGrantDocuments`:

```ts
export async function countGrantDocuments(
	db: Db,
	grantId: string,
	options: DeliveryOptions
): Promise<number> {
	// One row, always. Until 3b this was a plain `count(*)`; 3b had to ship the
	// rows themselves so `narrowByAgreements` could filter them, which for a
	// tier-wide grant means the whole catalogue over the wire to produce an
	// integer — once per due grant, in a six-hourly job.
	//
	// The two flags are what make the aggregate safe again: when nothing the
	// grant confers is at the `nda` tier and no group it touches carries an
	// agreement, narrowing provably cannot remove a row, so there is nothing to
	// narrow and the count is the answer.
	const [summary] = await db
		.select({
			total: sql<number>`count(DISTINCT ${document.id})::int`,
			gated: sql<boolean>`bool_or(${document.tier} = 'nda' OR ${accessGroup.ndaTemplateId} IS NOT NULL)`
		})
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.leftJoin(documentGroup, eq(documentGroup.documentId, document.id))
		.leftJoin(accessGroup, eq(accessGroup.id, documentGroup.groupId))
		.where(eq(accessGrant.id, grantId));

	if (!summary) return 0;
	if (!summary.gated) return summary.total;

	const rows = foldConferred(await conferredSelect(db, eq(accessGrant.id, grantId)));
	return (await narrowByAgreements(db, rows, options)).length;
}
```

- [ ] **Step 2: Assert both paths, not just the one the fixtures happen to take**

§14 asks for the case where narrowing cannot remove anything and the aggregate is allowed back. Add to `tests/integration/nda-grants.test.ts`, following the file's existing seeding and its clean-children-before-parents teardown:

```ts
it('counts a grant that touches no agreement without narrowing it', async () => {
	// The aggregate path. A document in two groups, neither carrying an
	// agreement: the left joins multiply the row, so a plain count(*) would
	// report two documents where there is one.
	const grantId = await seedGrantOverDocumentInTwoPlainGroups(db);

	expect(await countGrantDocuments(db, grantId, { locales: ['de', 'en'] })).toBe(1);
});

it('counts a grant behind an unaccepted agreement as delivering nothing', async () => {
	// The narrowing path, which the aggregate must not short-circuit.
	const grantId = await seedGrantOverNdaTierDocument(db);

	expect(await countGrantDocuments(db, grantId, { locales: ['de', 'en'] })).toBe(0);
});
```

Write the two seed helpers against the file's existing fixture style; if it already has equivalents, use those and only add the assertions.

- [ ] **Step 3: Verify**

```sh
pnpm test:integration tests/integration/expiry.test.ts
pnpm test:integration tests/integration/nda-grants.test.ts
pnpm test:integration
```

Expected: PASS. If a count comes back wrong by exactly the number of group memberships, `count(DISTINCT …)` was dropped — the left joins multiply rows and a plain `count(*)` would over-count.

- [ ] **Step 3: Commit**

```sh
pnpm format
git add src/lib/server/access/grants.ts
git commit -m "perf(access): count a grant's documents without fetching them"
```

(This is Step 4.)

---

### Task 23: Stop reading every candidate body to test locale completeness

`effectiveVersion` selects whole `nda_template_body` rows — `bodyMd` included — for every candidate version, then keeps the first version that has a body in each enabled locale. Testing completeness needs `(versionId, locale)`; the body is needed only to render. 3b put this on the download path through `validAcceptance`, and three of its four callers never touch `bodies` at all.

**Files:**
- Modify: `src/lib/server/nda/templates.ts`
- Test: `tests/integration/nda-templates.test.ts`, `tests/integration/nda-acceptance.test.ts` (must pass unchanged)

- [ ] **Step 1: Split the completeness test from the render fetch**

In `effectiveVersion`, replace the body query and the loop:

```ts
	// `(versionId, locale)` is the whole completeness question; `bodyMd` is only
	// needed to render, and three of this function's four callers never look at
	// it. Reading every candidate's full body put a table scan's worth of
	// contract text on the gated download path, where `validAcceptance` calls in.
	const present = await db
		.select({ versionId: ndaTemplateBody.versionId, locale: ndaTemplateBody.locale })
		.from(ndaTemplateBody)
		.where(
			inArray(
				ndaTemplateBody.versionId,
				candidates.map((row) => row.id)
			)
		);

	const localesByVersion = groupByKey(present, (row) => row.versionId);

	const winner = candidates.find((candidate) => {
		const found = new Set((localesByVersion.get(candidate.id) ?? []).map((row) => row.locale));
		return locales.every((locale) => found.has(locale));
	});

	if (!winner) return null;

	const bodyRows = await db
		.select()
		.from(ndaTemplateBody)
		.where(eq(ndaTemplateBody.versionId, winner.id));

	const bodies: Record<string, { bodyMd: string; sha256: string }> = {};
	for (const row of bodyRows) bodies[row.locale] = { bodyMd: row.bodyMd, sha256: row.sha256 };

	return { versionId: winner.id, version: winner.version, bodies };
```

- [ ] **Step 2: Verify**

```sh
pnpm test:integration tests/integration/nda-templates.test.ts
pnpm test:integration tests/integration/nda-acceptance.test.ts
pnpm test:integration
```

Expected: PASS, unchanged. The case that matters is a version refusing to become effective with a locale missing (§5.2) — it must still refuse.

- [ ] **Step 3: Commit**

```sh
pnpm format
git add src/lib/server/nda/templates.ts
git commit -m "perf(nda): test locale completeness without reading the bodies"
```

---

### Task 24: Gate 4 — the read-path theme is complete

- [ ] **Step 1: Full suite**

```sh
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green, 0 errors, 0 warnings.

- [ ] **Step 2: Confirm the build still needs no environment**

```sh
env -u DATABASE_URL -u OIDC_CLIENT_SECRET -u SMTP_URL pnpm build
```

Expected: succeeds. This is the check that catches an extraction library imported at module scope from something a route pulls in eagerly.

- [ ] **Step 3: Confirm nothing new reached the public bundle**

```sh
node -e "
const { readdirSync, readFileSync, statSync } = require('node:fs');
const root = '.svelte-kit/output/client/_app/immutable';
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = dir + '/' + name;
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!path.endsWith('.js')) continue;
    const text = readFileSync(path, 'utf8');
    if (/milkdown|pdfjs|mammoth/i.test(text)) hits.push(path);
  }
};
walk(root);
console.log(hits.length ? 'admin-only chunks to verify:\n' + hits.join('\n') : 'no matches at all');
"
```

Expected: either no matches, or matches only in lazily-loaded chunks — never in an entry or a chunk a portal route imports. §10.4 is a product claim, not a preference. Then open the portal in a browser and confirm the network tab shows no request for those chunks.

---

### Task 25: Close the phase

**Files:**
- Create: `docs/superpowers/phase-3d-carryover.md`
- Modify: `README.md` if any operator-visible behaviour changed (it should not have)

- [ ] **Step 1: Write the carry-over**

Follow `docs/superpowers/phase-3c-carryover.md`'s shape exactly: the questions the plan asked and what the answers turned out to be, decisions this phase settled that the plan did not, defects found and fixed with the reasoning that matters, what is still open, and the numbers at the close.

Answer at least these three, because they are what this plan bet on:

1. **Did the serializer actually enforce P3.21?** The claim is that `remark-stringify` escaping `1. ` is what keeps an enumerated clause out of an ordered list, rather than a check somebody could forget. Record whether that held for a real contract, not only for the fixture.
2. **What did the PDF grouper's constants have to become?** §16 predicted the thresholds would be wrong on the first real document. Record what they started as, what they ended as, and against what.
3. **Did the Milkdown schema get restricted, or did the escape hatch get used?** If the full commonmark preset shipped, say so plainly and record it as an open item — §5.1 already says the server refusal is the control, so this is a documented gap rather than a defect.

- [ ] **Step 2: Record the numbers**

```sh
pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Put the counts in the carry-over's closing table, in the same shape 3b used. Note that this phase adds **no migrations** — if the count is not zero, something went wrong against a Global Constraint.

- [ ] **Step 3: Commit**

```sh
pnpm format
git add docs/superpowers/phase-3d-carryover.md
git commit -m "docs: close phase 3c"
```
