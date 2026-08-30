<script lang="ts">
	import { enhance } from '$app/forms';
	import { ACCESS_RULE_ACTIONS } from '$lib/access-types';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { DOCUMENT_TIERS } from '$lib/content-types';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const ACTION_LABEL: Record<string, () => string> = {
		auto_approve: () => m.admin_rule_action_auto_approve(),
		review: () => m.admin_rule_action_review(),
		deny: () => m.admin_rule_action_deny()
	};
</script>

<div class="mb-6">
	<a href={localizePath('/admin/rules', data.locale)} class="text-sm underline underline-offset-4"
		>{m.nav_rules()}</a
	>
	<h1 class="mt-1 font-mono text-2xl font-semibold">{data.rule.pattern}</h1>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_rule_pattern()}>
		<input
			data-testid="rule-pattern"
			name="pattern"
			value={data.rule.pattern}
			class="rounded border px-2 py-1 font-mono"
		/>
		<span class="text-xs text-neutral-500">{m.admin_rule_pattern_hint()}</span>
	</FormField>

	<FormField label={m.admin_rule_action()}>
		<select data-testid="rule-action" name="action" class="rounded border px-2 py-1">
			{#each ACCESS_RULE_ACTIONS as action (action)}
				<option value={action} selected={action === data.rule.action}
					>{ACTION_LABEL[action]?.() ?? action}</option
				>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_tier()}>
		<select data-testid="rule-max-tier" name="maxTier" class="rounded border px-2 py-1">
			{#each DOCUMENT_TIERS as tier (tier)}
				<option value={tier} selected={tier === data.rule.maxTier}>{tier}</option>
			{/each}
		</select>
		<span class="text-xs text-neutral-500">{m.admin_rule_max_tier_hint()}</span>
	</FormField>

	<FormField label={m.admin_priority()}>
		<input
			type="number"
			data-testid="rule-priority"
			name="priority"
			value={data.rule.priority}
			class="rounded border px-2 py-1"
		/>
		<span class="text-xs text-neutral-500">{m.admin_priority_hint()}</span>
	</FormField>

	<FormField label={m.admin_note()}>
		<input
			data-testid="rule-note"
			name="note"
			value={data.rule.note ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	{#if form?.field === 'pattern'}
		<p data-testid="error-pattern" class="text-sm text-red-700">{m.admin_error_pattern()}</p>
	{:else if form?.field}
		<p data-testid="error-rule" class="text-sm text-red-700">{m.admin_error_required()}</p>
	{:else if form?.saved}
		<p data-testid="rule-saved" class="text-sm text-green-700">{m.admin_saved()}</p>
	{/if}

	<button
		data-testid="rule-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>

<form method="POST" action="?/remove" use:enhance class="mt-10">
	<button
		data-testid="rule-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
