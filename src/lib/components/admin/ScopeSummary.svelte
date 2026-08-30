<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { ScopeTier } from '$lib/access-types';

	/**
	 * One rendering of a scope, shared by the grants list, the request queue and
	 * the requester detail page. Scope is three parallel sets, and three copies
	 * of this could disagree about what somebody holds — the same reason
	 * `grantCoversDocument` is named once on the server.
	 *
	 * A request carries no groups (§4.2 keeps them off the public form), so
	 * `groupIds` defaults to empty rather than being required.
	 */
	let {
		tiers,
		documentCount,
		groupIds = [],
		groupNames = {}
	}: {
		tiers: ScopeTier[];
		documentCount: number;
		groupIds?: string[];
		groupNames?: Record<string, string>;
	} = $props();

	const TIER_LABEL: Record<string, () => string> = {
		request: () => m.request_tier_request(),
		nda: () => m.request_tier_nda()
	};

	let parts = $derived([
		...tiers.map((tier) => TIER_LABEL[tier]?.() ?? tier),
		...groupIds.map((id) => groupNames[id] ?? id),
		...(documentCount > 0 ? [m.admin_scope_document_count({ count: documentCount })] : [])
	]);
</script>

<span data-testid="scope-summary" class="text-sm text-neutral-600">
	{parts.length > 0 ? parts.join(' · ') : m.admin_scope_empty()}
</span>
