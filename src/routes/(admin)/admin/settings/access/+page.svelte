<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
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

	{#if form?.field}
		<p data-testid="error-grant-default-days" class="text-sm text-red-700">
			{m.admin_error_required()}
		</p>
	{:else if form?.saved}
		<p data-testid="access-saved" class="text-sm text-green-700">{m.admin_saved()}</p>
	{/if}

	<button
		data-testid="access-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>
