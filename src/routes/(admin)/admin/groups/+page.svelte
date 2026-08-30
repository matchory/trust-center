<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizePath } from '$lib/i18n/locale';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.nav_groups()}</h1>

<form
	method="POST"
	action="?/create"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input data-testid="group-slug" name="slug" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_position()}>
		<input name="position" type="number" value="0" class="rounded border px-2 py-1" />
	</FormField>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="group-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>

<ul class="divide-y rounded border bg-white">
	{#each data.groups as group (group.id)}
		<li class="flex flex-wrap items-center gap-3 p-4" data-testid="group-row-{group.slug}">
			<a
				href={localizePath(`/admin/groups/${group.id}`, data.locale)}
				class="font-medium underline"
			>
				{group.names[data.locale] ?? group.slug}
			</a>
			<span class="font-mono text-sm text-neutral-500">{group.slug}</span>
			<span data-testid="group-member-count" class="text-sm text-neutral-500">
				{m.admin_group_members_count({ count: group.documentCount })}
			</span>
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
