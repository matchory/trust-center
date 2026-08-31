import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { listTemplates } from '$lib/server/nda/templates';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	templates: await listTemplates(getDb(), getConfig().locales)
});
