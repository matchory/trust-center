<script lang="ts" generics="Row extends { id: string }">
	import { m } from '$lib/paraglide/messages.js';

	interface Column {
		key: string;
		header: string;
	}

	let {
		rows,
		columns,
		searchText,
		cell,
		testIdPrefix = 'row'
	}: {
		rows: readonly Row[];
		columns: readonly Column[];
		/** The searchable text for a row. Filtering is client-side: a trust
		 * center has tens of entries, and the whole list is already in the
		 * payload. */
		searchText: (row: Row) => string;
		cell: import('svelte').Snippet<[Row, string]>;
		testIdPrefix?: string;
	} = $props();

	let query = $state('');

	let visible = $derived(
		rows.filter((row) => searchText(row).toLowerCase().includes(query.trim().toLowerCase()))
	);
</script>

<input
	data-testid="{testIdPrefix}-search"
	bind:value={query}
	placeholder={m.admin_search()}
	class="mb-3 rounded border px-2 py-1 text-sm"
/>

<table class="w-full rounded border bg-white text-sm">
	<thead class="border-b bg-neutral-50 text-left">
		<tr>
			{#each columns as column (column.key)}<th class="p-3">{column.header}</th>{/each}
		</tr>
	</thead>
	<tbody class="divide-y">
		{#each visible as row (row.id)}
			<tr data-testid="{testIdPrefix}-{row.id}">
				{#each columns as column (column.key)}
					<td class="p-3">{@render cell(row, column.key)}</td>
				{/each}
			</tr>
		{:else}
			<tr><td colspan={columns.length} class="p-4 text-neutral-500">{m.admin_no_entries()}</td></tr>
		{/each}
	</tbody>
</table>
