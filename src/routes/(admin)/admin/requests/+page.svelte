<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import ScopeSummary from '$lib/components/admin/ScopeSummary.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const STATUS_LABEL: Record<string, () => string> = {
		pending: () => m.admin_request_status_pending(),
		info_requested: () => m.admin_request_status_info_requested(),
		approved: () => m.admin_request_status_approved(),
		denied: () => m.admin_request_status_denied()
	};

	let columns = $derived([
		{ key: 'requester', header: m.admin_requester() },
		{ key: 'company', header: m.admin_company() },
		{ key: 'scope', header: m.admin_scope() },
		{ key: 'status', header: m.admin_status() },
		{ key: 'requestedAt', header: m.admin_requested_at() }
	]);

	// Pending first, because that is the only status carrying work; within a
	// status the newest is the one most likely being asked about.
	const ORDER = ['pending', 'info_requested', 'approved', 'denied'];
	let rows = $derived(
		[...data.requests].sort(
			(a, b) =>
				ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
				b.createdAt.getTime() - a.createdAt.getTime()
		)
	);
</script>

<div class="mb-6">
	<h1 class="text-2xl font-semibold">{m.nav_requests()}</h1>
	<p class="mt-1 text-sm text-neutral-600">{m.admin_requests_intro()}</p>
</div>

<DataTable
	{rows}
	{columns}
	testIdPrefix="request"
	searchText={(row) => [row.email, row.name, row.company, row.status].join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'requester'}
			<a
				href={localizePath(`/admin/requests/${row.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{row.email}
			</a>
			<span class="ml-2 text-xs text-neutral-500">{row.name}</span>
		{:else if key === 'company'}{row.company}
		{:else if key === 'scope'}
			<!-- A request carries no groups: §4.2 keeps them off the public form. -->
			<ScopeSummary tiers={row.tiers} documentCount={row.documentCount} />
		{:else if key === 'status'}
			<span data-testid="request-status-{row.id}">{STATUS_LABEL[row.status]?.() ?? row.status}</span
			>
		{:else if key === 'requestedAt'}{formatDate(row.createdAt, data.locale)}{/if}
	{/snippet}
</DataTable>
