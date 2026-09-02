import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stampPdf } from '../../src/lib/server/delivery/watermark';
import { blankPdf, drawnText } from '../helpers/pdf';

const FONT_DIR = './assets/fonts';

const recipient = {
	name: 'A Person',
	company: 'Acme GmbH',
	email: 'a.person@acme.example',
	at: new Date('2026-08-29T10:00:00Z'),
	notice: 'Confidential — provided under access grant.'
};

let exporter: InMemorySpanExporter;

beforeAll(() => {
	// `trace.setGlobalTracerProvider` silently refuses a second registration
	// (returns false, no throw) once one is already registered on globalThis —
	// disable first so this file's provider actually takes effect, and
	// register once here rather than per test so a later test's fresh exporter
	// state is not silently ignored.
	trace.disable();
	exporter = new InMemorySpanExporter();
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
	);
});

beforeEach(() => exporter.reset());

afterAll(() => {
	// Leave the global tracing API as this file found it, for whichever test
	// file's `beforeAll` runs next in the same worker.
	trace.disable();
});

describe('stampPdf', () => {
	it('returns a valid PDF with the same page count', async () => {
		const stamped = await stampPdf(await blankPdf(3), FONT_DIR, recipient);
		const reloaded = await PDFDocument.load(stamped);

		expect(reloaded.getPageCount()).toBe(3);
	});

	it('embeds the recipient identity in the document text', async () => {
		const drawn = await drawnText(await stampPdf(await blankPdf(1), FONT_DIR, recipient));

		expect(drawn).toContain('Acme GmbH');
		expect(drawn).toContain('a.person@acme.example');
		expect(drawn).toContain('A Person');
	});

	it('produces different bytes for different recipients', async () => {
		// The whole point of a per-recipient watermark: two copies of the same
		// document must not be interchangeable.
		const source = await blankPdf(1);
		const a = await stampPdf(source, FONT_DIR, recipient);
		const b = await stampPdf(source, FONT_DIR, { ...recipient, email: 'other@acme.example' });

		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it('rejects bytes that are not a PDF rather than emitting a broken file', async () => {
		await expect(stampPdf(new Uint8Array([1, 2, 3]), FONT_DIR, recipient)).rejects.toThrow();
	});

	it('produces a larger file than it was given', async () => {
		// Cheap proof that content was actually added: a stamper that silently
		// returned its input would pass every assertion above this one.
		const source = await blankPdf(1);
		const stamped = await stampPdf(source, FONT_DIR, recipient);

		expect(stamped.byteLength).toBeGreaterThan(source.byteLength);
	});

	it('stamps a name outside WinAnsi without mangling it', async () => {
		// Previously `Šimon Čech` was stamped `?imon ?ech` — the identical defect one
		// layer over from the record PDF, and on a document the requester keeps.
		const stamped = await stampPdf(await blankPdf(), FONT_DIR, {
			name: 'Šimon Čech',
			company: 'Firma s.r.o.',
			email: 'simon@firma.example',
			at: new Date('2026-06-01T00:00:00Z'),
			notice: 'Vertraulich'
		});

		expect(await drawnText(stamped)).toContain('Šimon Čech');
	});

	it('stamps every page, not only the first', async () => {
		// Cropping the stamped page out is the obvious attack on a first-page
		// watermark, so each page carries its own.
		const drawn = await drawnText(await stampPdf(await blankPdf(3), FONT_DIR, recipient));

		expect(drawn.split('a.person@acme.example').length - 1).toBe(3);
	});
});

describe('stampPdf telemetry', () => {
	// The slowest thing this application does on a request path, and the only
	// one that buffers a whole file — so it is worth its own span. It is also
	// the span with the most dangerous neighbours: `recipient` carries a name,
	// a company and an email, and every one of them is forbidden (spec §8).
	it('emits a span with the page count and nothing about the recipient', async () => {
		await stampPdf(await blankPdf(3), FONT_DIR, recipient);

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('document watermark');
		expect(spans[0]?.attributes['document.pages']).toBe(3);

		const values = [spans[0]?.name ?? '', ...Object.values(spans[0]?.attributes ?? {}).map(String)];
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => value.includes('Acme'))).toBe(false);
		expect(values.some((value) => value.includes('A Person'))).toBe(false);
	});
});
