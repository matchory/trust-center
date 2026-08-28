import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { parseConfig, type AppConfig } from './parse';

let cached: AppConfig | undefined;

/**
 * Parsed lazily so importing this module never requires a configured
 * environment — `vite build` must not need runtime secrets.
 */
export function getConfig(): AppConfig {
	return (cached ??= parseConfig(process.env, COMPILED_LOCALES));
}

export type { AppConfig } from './parse';
