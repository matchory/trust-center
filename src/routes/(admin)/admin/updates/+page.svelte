<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'title', header: m.admin_title() },
		{ key: 'kind', header: m.admin_kind() },
		{ key: 'publishedAt', header: m.admin_published_at() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_updates()}</h1>
	<a
		href={localizePath('/admin/updates/new', data.locale)}
		data-testid="updates-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.posts}
	{columns}
	testIdPrefix="updates"
	searchText={(post) => [post.slug, ...Object.values(post.titles)].join(' ')}
>
	{#snippet cell(post, key)}
		{#if key === 'title'}
			<a
				href={localizePath(`/admin/updates/${post.id}`, data.locale)}
				class="font-medium underline underline-offset-4"
			>
				{post.titles[data.locale] ?? post.titles[data.defaultLocale] ?? post.slug}
			</a>
			<span class="ml-2 font-mono text-xs text-neutral-400">{post.slug}</span>
		{:else if key === 'kind'}{post.kind}
		{:else if key === 'publishedAt'}
			{post.publishedAt ? formatDate(post.publishedAt, data.locale) : '—'}
		{/if}
	{/snippet}
</DataTable>
