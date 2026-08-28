import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db';
import { setting } from '../db/schema';

export const BRANDING_SETTING_KEY = 'branding';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const httpsUrl = z.string().url().startsWith('https://');

const schema = z.object({
	organizationName: z.string().min(1).max(120).default('Trust Center'),
	primaryColor: hexColor.default('#171717'),
	surfaceColor: hexColor.default('#FAFAFA'),
	inkColor: hexColor.default('#171717'),
	logoStorageKey: z.string().nullable().default(null),
	logoContentType: z.enum(['image/png', 'image/svg+xml', 'image/webp']).nullable().default(null),
	imprintUrl: httpsUrl.nullable().default(null),
	privacyUrl: httpsUrl.nullable().default(null),
	contactEmail: z.string().email().nullable().default(null)
});

export type Branding = z.infer<typeof schema>;

/** Throws on invalid input rather than silently defaulting: a stored value
 * that fails validation is a configuration error an operator must see. */
export function parseBranding(value: unknown): Branding {
	return schema.parse(value ?? {});
}

export async function getBranding(db: Db): Promise<Branding> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, BRANDING_SETTING_KEY))
		.limit(1);

	return parseBranding(row?.value);
}

export async function setBranding(db: Db, values: Branding): Promise<void> {
	await db
		.insert(setting)
		.values({ key: BRANDING_SETTING_KEY, value: values })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value: values, updatedAt: new Date() }
		});
}

/**
 * Served from /branding.css rather than inlined in a <style> tag, which is the
 * only reason the Content-Security-Policy can keep style-src at 'self' with no
 * unsafe-inline. Colours are validated as six-digit hex above, so nothing here
 * can close the declaration block.
 */
export function brandingCss(branding: Branding): string {
	return `:root {\n\t--tc-primary: ${branding.primaryColor};\n\t--tc-surface: ${branding.surfaceColor};\n\t--tc-ink: ${branding.inkColor};\n}\n`;
}
