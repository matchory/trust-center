<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const categoryName = (id: string) =>
		data.categories.find((category) => category.id === id)?.slug ?? '';

	let columns = $derived([
		{ key: 'title', header: m.admin_title() },
		{ key: 'category', header: m.admin_category() },
		{ key: 'tier', header: m.admin_tier() },
		{ key: 'status', header: m.admin_status() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_documents()}</h1>
	<a
		href={localizePath('/admin/documents/categories', data.locale)}
		class="ml-auto rounded border px-3 py-1.5 text-sm">{m.admin_categories()}</a
	>
	<a
		href={localizePath('/admin/documents/new', data.locale)}
		data-testid="documents-new"
		class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.documents}
	{columns}
	testIdPrefix="documents"
	searchText={(doc) => [doc.slug, ...Object.values(doc.titles)].join(' ')}
>
	{#snippet cell(doc, key)}
		{#if key === 'title'}
			<a
				href={localizePath(`/admin/documents/${doc.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{doc.titles[data.locale] ?? doc.titles[data.defaultLocale] ?? doc.slug}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{doc.slug}</span>
		{:else if key === 'category'}{categoryName(doc.categoryId)}
		{:else if key === 'tier'}{doc.tier}
		{:else if key === 'status'}{doc.status}{/if}
	{/snippet}
</DataTable>
