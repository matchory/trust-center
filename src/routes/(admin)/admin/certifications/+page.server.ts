import { listCertificationsForAdmin } from '$lib/server/content/certifications';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	certifications: await listCertificationsForAdmin(getDb())
});
