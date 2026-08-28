<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'question', header: m.admin_question() },
		{ key: 'category', header: m.admin_category() },
		{ key: 'visibility', header: m.admin_visibility() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_faq()}</h1>
	<a
		href={localizePath('/admin/faq/new', data.locale)}
		data-testid="faq-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.answers}
	{columns}
	testIdPrefix="faq"
	searchText={(item) => [item.slug, item.category, ...Object.values(item.questions)].join(' ')}
>
	{#snippet cell(item, key)}
		{#if key === 'question'}
			<a
				href={localizePath(`/admin/faq/${item.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{item.questions[data.locale] ?? item.questions[data.defaultLocale] ?? item.slug}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{item.slug}</span>
		{:else if key === 'category'}{item.category}
		{:else if key === 'visibility'}{item.visibility}{/if}
	{/snippet}
</DataTable>
