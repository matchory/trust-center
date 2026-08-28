<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'name', header: m.admin_name() },
		{ key: 'country', header: m.subprocessors_country() },
		{ key: 'published', header: m.admin_published() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_subprocessors()}</h1>
	<a
		href={localizePath('/admin/subprocessors/new', data.locale)}
		data-testid="subprocessors-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.subprocessors}
	{columns}
	testIdPrefix="subprocessors"
	searchText={(item) => [item.slug, item.name, item.legalEntity].join(' ')}
>
	{#snippet cell(item, key)}
		{#if key === 'name'}
			<a
				href={localizePath(`/admin/subprocessors/${item.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{item.name}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{item.slug}</span>
		{:else if key === 'country'}{item.country}
		{:else if key === 'published'}{item.published ? '✓' : '—'}{/if}
	{/snippet}
</DataTable>
