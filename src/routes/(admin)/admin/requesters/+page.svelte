<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'email', header: m.admin_requester() },
		{ key: 'company', header: m.admin_company() },
		{ key: 'firstSeenAt', header: m.admin_first_seen_at() },
		{ key: 'grants', header: m.nav_grants() },
		{ key: 'state', header: m.admin_status() }
	]);
</script>

<div class="mb-6">
	<h1 class="text-2xl font-semibold">{m.nav_requesters()}</h1>
	<p class="mt-1 text-sm text-neutral-600">{m.admin_requesters_intro()}</p>
</div>

<DataTable
	rows={data.requesters}
	{columns}
	testIdPrefix="requester"
	searchText={(row) => [row.email, row.name, row.company].join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'email'}
			<a
				href={localizePath(`/admin/requesters/${row.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{row.email}
			</a>
			<span class="ml-2 text-xs text-neutral-500">{row.name}</span>
		{:else if key === 'company'}{row.company}
		{:else if key === 'firstSeenAt'}{formatDate(row.firstSeenAt, data.locale)}
		{:else if key === 'grants'}{row.grantCount}
		{:else if key === 'state'}
			<span data-testid="requester-state-{row.id}"
				>{row.purgedAt ? m.admin_requester_purged() : m.admin_requester_active()}</span
			>
		{/if}
	{/snippet}
</DataTable>
