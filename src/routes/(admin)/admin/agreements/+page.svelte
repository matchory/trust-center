<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'name', header: m.admin_agreement_name() },
		{ key: 'status', header: m.admin_agreement_status() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_agreements()}</h1>
	<a
		href={localizePath('/admin/agreements/new', data.locale)}
		data-testid="agreement-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.templates}
	{columns}
	testIdPrefix="agreement"
	searchText={(row) => [row.slug, row.names[data.locale] ?? ''].join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'name'}
			<a
				href={localizePath(`/admin/agreements/${row.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{row.names[data.locale] ?? row.slug}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{row.slug}</span>
		{:else if key === 'status'}
			{#if row.retiredAt}
				{m.admin_agreement_retired()}
			{:else if row.effectiveVersionNumber !== null}
				{m.admin_agreement_effective({ version: row.effectiveVersionNumber })}
			{:else}
				{m.admin_agreement_no_effective_version()}
				{#if row.blockedLocales.length > 0}
					<span class="ml-1 text-neutral-500">
						({m.admin_agreement_blocked_locales({ locales: row.blockedLocales.join(', ') })})
					</span>
				{/if}
			{/if}
		{/if}
	{/snippet}
</DataTable>
