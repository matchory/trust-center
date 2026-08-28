<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const groupName = (id: string) => data.groups.find((group) => group.id === id)?.slug ?? '';

	let columns = $derived([
		{ key: 'title', header: m.admin_title() },
		{ key: 'group', header: m.admin_group() },
		{ key: 'published', header: m.admin_published() },
		{ key: 'status', header: m.admin_status() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_controls()}</h1>
	<a
		href={localizePath('/admin/controls/groups', data.locale)}
		class="ml-auto rounded border px-3 py-1.5 text-sm">{m.admin_groups()}</a
	>
	<a
		href={localizePath('/admin/controls/new', data.locale)}
		data-testid="controls-new"
		class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.controls}
	{columns}
	testIdPrefix="controls"
	searchText={(item) => [item.slug, ...Object.values(item.titles)].join(' ')}
>
	{#snippet cell(item, key)}
		{#if key === 'title'}
			<a
				href={localizePath(`/admin/controls/${item.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{item.titles[data.locale] ?? item.titles[data.defaultLocale] ?? item.slug}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{item.slug}</span>
		{:else if key === 'group'}{groupName(item.groupId)}
		{:else if key === 'published'}{item.published ? '✓' : '—'}
		{:else if key === 'status'}{item.status}{/if}
	{/snippet}
</DataTable>
