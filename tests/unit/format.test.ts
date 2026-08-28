import { describe, expect, it } from 'vitest';
import { fileValidity, formatBytes, formatDate } from '../../src/lib/format';

const now = new Date('2026-06-01T12:00:00Z');

describe('fileValidity', () => {
	it('is current when there are no dates at all', () => {
		expect(fileValidity({ validFrom: null, validUntil: null }, now)).toBe('current');
	});

	it('is current inside the validity window', () => {
		expect(
			fileValidity(
				{
					validFrom: new Date('2026-01-01T00:00:00Z'),
					validUntil: new Date('2027-01-01T00:00:00Z')
				},
				now
			)
		).toBe('current');
	});

	it('is expiring within 60 days of validUntil', () => {
		expect(
			fileValidity({ validFrom: null, validUntil: new Date('2026-07-01T00:00:00Z') }, now)
		).toBe('expiring');
	});

	it('is expired after validUntil', () => {
		expect(
			fileValidity({ validFrom: null, validUntil: new Date('2026-05-31T00:00:00Z') }, now)
		).toBe('expired');
	});

	it('is not-yet-valid before validFrom', () => {
		expect(
			fileValidity({ validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: null }, now)
		).toBe('not-yet-valid');
	});
});

describe('formatBytes', () => {
	it('formats with the locale’s decimal separator', () => {
		expect(formatBytes(1_500_000, 'de')).toMatch(/1,5\s?MB/);
		expect(formatBytes(1_500_000, 'en')).toMatch(/1\.5\s?MB/);
	});

	it('formats small files in kilobytes', () => {
		expect(formatBytes(2048, 'en')).toMatch(/2(\.0)?\s?kB/);
	});
});

describe('formatDate', () => {
	it('formats in the requested locale', () => {
		expect(formatDate(new Date('2026-03-09T00:00:00Z'), 'de')).toBe('09.03.2026');
	});
});
