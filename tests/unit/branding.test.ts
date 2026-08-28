import { describe, expect, it } from 'vitest';
import { brandingCss, parseBranding } from '../../src/lib/server/content/branding';

describe('parseBranding', () => {
	it('fills every field on a fresh install', () => {
		const branding = parseBranding(undefined);
		expect(branding.organizationName).toBe('Trust Center');
		expect(branding.primaryColor).toMatch(/^#[0-9a-f]{6}$/i);
		expect(branding.logoStorageKey).toBeNull();
	});

	it('keeps valid stored values', () => {
		const branding = parseBranding({
			organizationName: 'Matchory',
			primaryColor: '#0F62FE',
			surfaceColor: '#FAFAFA',
			inkColor: '#171717',
			logoStorageKey: null,
			logoContentType: null,
			imprintUrl: 'https://matchory.com/impressum',
			privacyUrl: null,
			contactEmail: 'security@matchory.com'
		});

		expect(branding.organizationName).toBe('Matchory');
		expect(branding.primaryColor).toBe('#0F62FE');
	});

	it('rejects a colour that is not a six-digit hex value', () => {
		// The value is interpolated into a stylesheet, so anything that could
		// close a declaration block has to be refused at the boundary.
		expect(() => parseBranding({ primaryColor: 'red; } body { display:none' })).toThrow();
		expect(() => parseBranding({ primaryColor: '#fff' })).toThrow();
	});

	it('rejects a non-https imprint URL', () => {
		expect(() => parseBranding({ imprintUrl: 'javascript:alert(1)' })).toThrow();
	});
});

describe('brandingCss', () => {
	it('emits the custom properties the components read', () => {
		const css = brandingCss(parseBranding({ primaryColor: '#0F62FE' }));
		expect(css).toContain('--tc-primary: #0F62FE');
		expect(css).toContain(':root');
	});
});
