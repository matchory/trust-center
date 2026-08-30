<script lang="ts">
	import { enhance } from '$app/forms';
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import ScopeSummary from '$lib/components/admin/ScopeSummary.svelte';
	import { formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const STATE_LABEL: Record<string, () => string> = {
		active: () => m.admin_grant_state_active(),
		expired: () => m.admin_grant_state_expired(),
		revoked: () => m.admin_grant_state_revoked()
	};

	let columns = $derived([
		{ key: 'requester', header: m.admin_requester() },
		{ key: 'company', header: m.admin_company() },
		{ key: 'scope', header: m.admin_scope() },
		{ key: 'grantedAt', header: m.admin_granted_at() },
		{ key: 'expiresAt', header: m.admin_expires_at() },
		{ key: 'state', header: m.admin_status() }
	]);
</script>

<div class="mb-6">
	<h1 class="text-2xl font-semibold">{m.nav_grants()}</h1>
	<p class="mt-1 text-sm text-neutral-600">{m.admin_grants_intro()}</p>
</div>

<DataTable
	rows={data.grants}
	{columns}
	testIdPrefix="grant"
	searchText={(row) => [row.email, row.name, row.company, row.state].join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'requester'}
			<span class="font-medium">{row.email}</span>
			<span class="ml-2 text-xs text-neutral-500">{row.name}</span>
		{:else if key === 'company'}{row.company}
		{:else if key === 'scope'}
			<ScopeSummary
				tiers={row.tiers}
				groupIds={row.groupIds}
				documentCount={row.documentCount}
				groupNames={data.groupNames}
			/>
		{:else if key === 'grantedAt'}{formatDate(row.grantedAt, data.locale)}
		{:else if key === 'expiresAt'}{formatDate(row.expiresAt, data.locale)}
		{:else if key === 'state'}
			<div class="flex items-center gap-3">
				<span data-testid="grant-state-{row.id}">{STATE_LABEL[row.state]?.() ?? row.state}</span>
				<!-- Only an active grant: revoking an expired one changes nothing a
				     download path reads, and offering it suggests otherwise. -->
				{#if row.state === 'active'}
					<form method="POST" action="?/revoke" use:enhance>
						<input type="hidden" name="grantId" value={row.id} />
						<button data-testid="grant-revoke-{row.id}" class="rounded border px-2 py-1 text-xs"
							>{m.admin_revoke()}</button
						>
					</form>
				{/if}
			</div>
		{/if}
	{/snippet}
</DataTable>
