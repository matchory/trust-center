<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { ACCEPTANCE_SCOPES } from '$lib/nda-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_access_settings()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<FormField label={m.admin_grant_default_days()}>
		<input
			type="number"
			min="1"
			data-testid="access-grant-default-days"
			name="grantDefaultDays"
			value={data.grantDefaultDays}
			required
			class="rounded border px-2 py-1"
		/>
		<span class="text-xs text-neutral-500"
			>{m.admin_grant_default_days_hint({ days: data.envDefault })}</span
		>
	</FormField>

	{#if form?.field === 'grantDefaultDays'}
		<p data-testid="error-grant-default-days" class="text-sm text-red-700">
			{m.admin_error_required()}
		</p>
	{/if}

	<FormField label={m.admin_agreement_default_template()}>
		<select
			name="defaultTemplateId"
			data-testid="nda-default-template"
			class="rounded border px-2 py-1"
		>
			<option value="" selected={data.defaultTemplateId === null}>
				{m.admin_agreement_default_template_none()}
			</option>
			{#each data.templates as template (template.id)}
				<option value={template.id} selected={template.id === data.defaultTemplateId}>
					{template.names[data.locale] ?? template.slug}
				</option>
			{/each}
		</select>
	</FormField>

	{#if form?.field === 'defaultTemplateId'}
		<p data-testid="error-default-template" class="text-sm text-red-700">
			{m.admin_error_required()}
		</p>
	{/if}

	<FormField label={m.admin_acceptance_scope()}>
		<div class="flex flex-col gap-1" data-testid="acceptance-scope">
			{#each ACCEPTANCE_SCOPES as option (option)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name="acceptanceScope"
						value={option}
						checked={option === data.acceptanceScope}
					/>
					{option === 'domain'
						? m.admin_acceptance_scope_domain()
						: m.admin_acceptance_scope_person()}
				</label>
			{/each}
		</div>
		<span class="text-xs text-neutral-500">{m.admin_acceptance_scope_hint()}</span>
	</FormField>

	{#if form?.field === 'acceptanceScope'}
		<p data-testid="error-acceptance-scope" class="text-sm text-red-700">
			{m.admin_error_required()}
		</p>
	{/if}

	<FormField label={m.admin_acceptance_due_days()}>
		<input
			type="number"
			min="1"
			data-testid="acceptance-due-days"
			name="acceptanceDueDays"
			value={data.acceptanceDueDays}
			required
			class="rounded border px-2 py-1"
		/>
		<span class="text-xs text-neutral-500"
			>{m.admin_acceptance_due_days_hint({ days: data.acceptanceDueDaysEnvDefault })}</span
		>
	</FormField>

	{#if form?.field === 'acceptanceDueDays'}
		<p data-testid="error-acceptance-due-days" class="text-sm text-red-700">
			{m.admin_error_required()}
		</p>
	{/if}

	{#if form?.saved}
		<p data-testid="access-saved" class="text-sm text-green-700">{m.admin_saved()}</p>
	{/if}

	<button
		data-testid="access-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>
