<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_new()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<FormField label={m.admin_slug()}>
		<input data-testid="subprocessor-slug" name="slug" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_name()}>
		<input data-testid="subprocessor-name" name="name" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_legal_entity()}>
		<input
			data-testid="subprocessor-legal-entity"
			name="legalEntity"
			required
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.subprocessors_country()}>
		<input
			data-testid="subprocessor-country"
			name="country"
			required
			maxlength="2"
			placeholder="DE"
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.subprocessors_region()}>
		<input
			data-testid="subprocessor-region"
			name="region"
			required
			placeholder="EU"
			class="rounded border px-2 py-1"
		/>
	</FormField>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="subprocessor-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>
