import type { Reroute } from '@sveltejs/kit';
import { LOCALES } from '$lib/i18n/locales';
import { stripLocale } from '$lib/i18n/locale';

export const reroute: Reroute = ({ url }) => stripLocale(url.pathname, LOCALES).path;
