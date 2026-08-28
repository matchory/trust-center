<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'framework', header: m.admin_framework() },
		{ key: 'issuer', header: m.admin_issuer() },
		{ key: 'published', header: m.admin_published() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_certifications()}</h1>
	<a
		href={localizePath('/admin/certifications/new', data.locale)}
		data-testid="certifications-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.certifications}
	{columns}
	testIdPrefix="certifications"
	searchText={(item) => [item.slug, item.framework, item.issuer].join(' ')}
>
	{#snippet cell(item, key)}
		{#if key === 'framework'}
			<a
				href={localizePath(`/admin/certifications/${item.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{item.framework}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{item.slug}</span>
		{:else if key === 'issuer'}{item.issuer}
		{:else if key === 'published'}{item.published ? '✓' : '—'}{/if}
	{/snippet}
</DataTable>
