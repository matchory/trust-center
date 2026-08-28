<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { UPDATE_KINDS } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_new()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<FormField label={m.admin_slug()}>
		<input data-testid="update-slug" name="slug" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_kind()}>
		<select data-testid="update-kind" name="kind" class="rounded border px-2 py-1">
			{#each UPDATE_KINDS as kind (kind)}
				<option value={kind}>{kind}</option>
			{/each}
		</select>
	</FormField>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="update-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>
