export type FileValidity = 'not-yet-valid' | 'current' | 'expiring' | 'expired';

/** Documents inside this window of their expiry are flagged, not hidden. */
const EXPIRING_SOON_DAYS = 60;

export function fileValidity(
	file: { validFrom: Date | null; validUntil: Date | null },
	now: Date = new Date()
): FileValidity {
	if (file.validFrom && file.validFrom.getTime() > now.getTime()) return 'not-yet-valid';
	if (!file.validUntil) return 'current';

	const remainingDays = (file.validUntil.getTime() - now.getTime()) / 86_400_000;
	if (remainingDays < 0) return 'expired';
	if (remainingDays <= EXPIRING_SOON_DAYS) return 'expiring';
	return 'current';
}

export function formatBytes(bytes: number, locale: string): string {
	// Intl handles the separators; the unit step is ours. Byte units are SI
	// here (kB, MB) rather than binary, matching what a file manager shows.
	const units = ['B', 'kB', 'MB', 'GB'] as const;
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}

	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function formatDate(date: Date, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: 'UTC'
	}).format(date);
}

/**
 * Audit timestamps, always in UTC and always saying so. A log read by someone
 * correlating it with server logs must not silently shift by the reader's
 * offset, so the zone is part of the rendered string rather than implied.
 */
export function formatDateTime(date: Date, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZone: 'UTC',
		timeZoneName: 'short'
	}).format(date);
}
