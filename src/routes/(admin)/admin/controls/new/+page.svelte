<script lang="ts">
	import { enhance } from '$app/forms';
	import { CONTROL_STATUSES } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_new()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input data-testid="control-slug" name="slug" required class="rounded border px-2 py-1" />
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_group()}
		<select data-testid="control-group" name="groupId" required class="rounded border px-2 py-1">
			{#each data.groups as group (group.id)}
				<option value={group.id}>{group.names[data.locale] ?? group.slug}</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_status()}
		<select data-testid="control-status" name="status" class="rounded border px-2 py-1">
			{#each CONTROL_STATUSES as status (status)}
				<option value={status}>{status}</option>
			{/each}
		</select>
	</label>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="control-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>
