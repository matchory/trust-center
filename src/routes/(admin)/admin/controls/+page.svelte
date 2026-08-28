<script lang="ts">
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');

	// Filtering client-side is right at this scale: a trust center has tens of
	// controls, not thousands, and the whole list is already in the payload.
	let visible = $derived(
		data.controls.filter((item) => {
			const haystack = [item.slug, ...Object.values(item.titles)].join(' ').toLowerCase();
			return haystack.includes(query.trim().toLowerCase());
		})
	);

	const groupName = (id: string) => data.groups.find((group) => group.id === id)?.slug ?? '';
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_controls()}</h1>
	<input
		data-testid="controls-search"
		bind:value={query}
		placeholder={m.admin_search()}
		class="ml-auto rounded border px-2 py-1 text-sm"
	/>
	<a
		href={localizePath('/admin/controls/groups', data.locale)}
		class="rounded border px-3 py-1.5 text-sm">{m.admin_groups()}</a
	>
	<a
		href={localizePath('/admin/controls/new', data.locale)}
		data-testid="controls-new"
		class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<table class="w-full rounded border bg-white text-sm">
	<thead class="border-b bg-neutral-50 text-left">
		<tr>
			<th class="p-3">{m.admin_title()}</th>
			<th class="p-3">{m.admin_group()}</th>
			<th class="p-3">{m.admin_published()}</th>
			<th class="p-3">{m.admin_status()}</th>
		</tr>
	</thead>
	<tbody class="divide-y">
		{#each visible as item (item.id)}
			<tr data-testid="row-{item.slug}">
				<td class="p-3">
					<a
						href={localizePath(`/admin/controls/${item.id}`, data.locale)}
						class="font-medium underline underline-offset-4"
					>
						{item.titles[data.locale] ?? item.titles[data.defaultLocale] ?? item.slug}
					</a>
					<span class="ml-2 font-mono text-xs text-neutral-400">{item.slug}</span>
				</td>
				<td class="p-3">{groupName(item.groupId)}</td>
				<td class="p-3">{item.published ? '✓' : '—'}</td>
				<td class="p-3">{item.status}</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="p-4 text-neutral-500">{m.admin_no_entries()}</td></tr>
		{/each}
	</tbody>
</table>
