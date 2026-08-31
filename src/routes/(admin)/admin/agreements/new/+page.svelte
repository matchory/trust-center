<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.nav_agreements()} · {m.admin_new()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<FormField label={m.admin_agreement_slug()}>
		<input
			data-testid="agreement-slug"
			name="slug"
			required
			placeholder="mutual-nda"
			class="rounded border px-2 py-1 font-mono"
		/>
	</FormField>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="agreement-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">{m.admin_new()}</button
	>
</form>
