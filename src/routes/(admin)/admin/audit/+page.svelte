<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { formatDateTime } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let columns = $derived([
		{ key: 'at', header: m.admin_audit_time() },
		{ key: 'action', header: m.admin_audit_action() },
		{ key: 'actor', header: m.admin_audit_actor() },
		{ key: 'subject', header: m.admin_audit_subject() },
		{ key: 'ip', header: m.admin_audit_ip() },
		{ key: 'details', header: m.admin_audit_details() }
	]);
</script>

<div class="mb-6">
	<h1 class="text-2xl font-semibold">{m.nav_audit()}</h1>
	<p class="mt-1 text-sm text-neutral-600">{m.admin_audit_intro()}</p>
</div>

<!-- GET, so a filtered view is a URL an auditor can be pointed at. Omitting
     `before` is deliberate: changing the filter starts paging over. -->
<form method="GET" data-testid="audit-filters" class="mb-4 flex flex-wrap items-end gap-3 text-sm">
	<label class="flex flex-col gap-1">
		<span class="text-neutral-600">{m.admin_audit_action()}</span>
		<input
			name="action"
			data-testid="audit-filter-action"
			value={data.filter.action}
			class="rounded border px-2 py-1"
		/>
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-neutral-600">{m.admin_audit_actor()}</span>
		<select name="actorType" data-testid="audit-filter-actor" class="rounded border px-2 py-1">
			<option value="">{m.admin_audit_actor_any()}</option>
			{#each data.actorTypes as actorType (actorType)}
				<option value={actorType} selected={data.filter.actorType === actorType}>{actorType}</option
				>
			{/each}
		</select>
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-neutral-600">{m.admin_audit_from()}</span>
		<input
			type="date"
			name="from"
			data-testid="audit-filter-from"
			value={data.filter.from}
			class="rounded border px-2 py-1"
		/>
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-neutral-600">{m.admin_audit_to()}</span>
		<input
			type="date"
			name="to"
			data-testid="audit-filter-to"
			value={data.filter.to}
			class="rounded border px-2 py-1"
		/>
	</label>

	<button data-testid="audit-filter-apply" class="rounded border px-3 py-1">
		{m.admin_audit_apply()}
	</button>
	<a href={localizePath('/admin/audit', data.locale)} class="px-1 py-1 underline"
		>{m.admin_audit_clear()}</a
	>
</form>

<DataTable
	rows={data.events}
	{columns}
	testIdPrefix="audit"
	searchText={(row) =>
		[row.action, row.actorType, row.actorId, row.subjectType, row.subjectId, row.ip]
			.filter(Boolean)
			.join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'at'}<span class="whitespace-nowrap">{formatDateTime(row.at, data.locale)}</span>
		{:else if key === 'action'}<span data-testid="audit-action-{row.id}" class="font-medium"
				>{row.action}</span
			>
		{:else if key === 'actor'}
			<span>{row.actorType}</span>
			{#if row.actorId}<span class="ml-1 block text-xs text-neutral-500">{row.actorId}</span>{/if}
		{:else if key === 'subject'}
			{#if row.subjectType}
				<span>{row.subjectType}</span>
				{#if row.subjectId}<span class="ml-1 block text-xs text-neutral-500">{row.subjectId}</span
					>{/if}
			{:else}—{/if}
		{:else if key === 'ip'}{row.ip ?? '—'}
		{:else if key === 'details'}
			<details data-testid="audit-details-{row.id}">
				<summary class="cursor-pointer text-neutral-600">{m.admin_audit_details()}</summary>
				<dl class="mt-2 space-y-2 text-xs">
					<div>
						<dt class="text-neutral-500">{m.admin_audit_meta()}</dt>
						<dd>
							<pre class="mt-1 overflow-x-auto rounded bg-neutral-50 p-2">{row.meta
									? JSON.stringify(row.meta, null, 2)
									: '—'}</pre>
						</dd>
					</div>
					<div>
						<dt class="text-neutral-500">{m.admin_audit_ua()}</dt>
						<dd class="break-all">{row.ua ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-neutral-500">{m.admin_audit_request_id()}</dt>
						<dd class="break-all">{row.requestId ?? '—'}</dd>
					</div>
				</dl>
			</details>
		{/if}
	{/snippet}
</DataTable>

{#if data.older}
	<a href={data.older} data-testid="audit-older" class="mt-4 inline-block text-sm underline"
		>{m.admin_audit_older()}</a
	>
{/if}
