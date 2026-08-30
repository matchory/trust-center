<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">
	{data.group.names[data.locale] ?? data.group.slug}
</h1>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.group.slug} required class="rounded border px-2 py-1" />
	</FormField>
	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.group.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>
	<button class="justify-self-start rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
</form>

<form
	method="POST"
	action="?/saveTranslations"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	{#each data.locales as locale (locale)}
		<FormField label={`${m.admin_name()} (${locale})`}>
			<input
				data-testid="group-name-{locale}"
				name="name.{locale}"
				value={data.group.names[locale] ?? ''}
				placeholder={m.admin_not_translated()}
				class="rounded border px-2 py-1"
			/>
		</FormField>
		<FormField label={`${m.admin_group_description()} (${locale})`}>
			<textarea
				data-testid="group-description-{locale}"
				name="description.{locale}"
				rows="2"
				class="rounded border px-2 py-1">{data.group.descriptions[locale] ?? ''}</textarea
			>
		</FormField>
	{/each}
	<button data-testid="group-save" class="justify-self-start rounded border px-3 py-1.5 text-sm">
		{m.admin_save()}
	</button>
</form>

<section class="mb-8 rounded border bg-white p-4">
	<h2 class="mb-2 font-medium">{m.admin_group_members()}</h2>
	<p class="text-sm text-neutral-500">
		{m.admin_group_members_count({ count: data.group.documentCount })} ·
		{m.admin_group_members_hint()}
	</p>
</section>

<form method="POST" action="?/remove" use:enhance>
	<button
		data-testid="group-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
	>
		{m.admin_delete()}
	</button>
</form>
