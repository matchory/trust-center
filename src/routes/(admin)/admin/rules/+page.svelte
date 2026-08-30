<script lang="ts">
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const ACTION_LABEL: Record<string, () => string> = {
		auto_approve: () => m.admin_rule_action_auto_approve(),
		review: () => m.admin_rule_action_review(),
		deny: () => m.admin_rule_action_deny()
	};

	let columns = $derived([
		{ key: 'pattern', header: m.admin_rule_pattern() },
		{ key: 'action', header: m.admin_rule_action() },
		{ key: 'maxTier', header: m.admin_tier() },
		{ key: 'priority', header: m.admin_priority() },
		{ key: 'note', header: m.admin_note() }
	]);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<div>
		<h1 class="text-2xl font-semibold">{m.nav_rules()}</h1>
		<p class="mt-1 text-sm text-neutral-600">{m.admin_rules_intro()}</p>
	</div>
	<a
		href={localizePath('/admin/rules/new', data.locale)}
		data-testid="rule-new"
		class="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<DataTable
	rows={data.rules}
	{columns}
	testIdPrefix="rule"
	searchText={(row) => [row.pattern, row.action, row.note ?? ''].join(' ')}
>
	{#snippet cell(row, key)}
		{#if key === 'pattern'}
			<a
				href={localizePath(`/admin/rules/${row.id}`, data.locale)}
				data-testid="rule-pattern-{row.id}"
				class="font-mono underline underline-offset-4"
			>
				{row.pattern}
			</a>
		{:else if key === 'action'}{ACTION_LABEL[row.action]?.() ?? row.action}
		{:else if key === 'maxTier'}
			<!-- Only `auto_approve` reads the ceiling; showing it elsewhere would
			     suggest it decides something. -->
			{row.action === 'auto_approve' ? row.maxTier : '—'}
		{:else if key === 'priority'}{row.priority}
		{:else if key === 'note'}{row.note ?? ''}{/if}
	{/snippet}
</DataTable>
