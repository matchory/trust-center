<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_categories()}</h1>

<form
	method="POST"
	action="?/create"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input data-testid="category-slug" name="slug" required class="rounded border px-2 py-1" />
	</FormField>

	{#each data.locales as locale (locale)}
		<FormField label={`${m.admin_name()} (${locale})`}>
			<input
				data-testid="category-name-{locale}"
				name="name.{locale}"
				class="rounded border px-2 py-1"
			/>
		</FormField>
	{/each}

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="category-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>

<ul class="divide-y rounded border bg-white">
	{#each data.categories as category (category.id)}
		<li class="p-4" data-testid="category-row-{category.slug}">
			<form method="POST" action="?/update" use:enhance class="flex flex-wrap items-end gap-3">
				<input type="hidden" name="id" value={category.id} />
				<span class="font-medium">{category.names[data.locale] ?? category.slug}</span>
				<span class="font-mono text-sm text-neutral-500">{category.slug}</span>

				{#each data.locales as locale (locale)}
					<FormField label={locale}>
						<input
							name="name.{locale}"
							value={category.names[locale] ?? ''}
							placeholder={m.admin_not_translated()}
							class="rounded border px-2 py-1"
						/>
					</FormField>
				{/each}

				<button class="rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
			</form>
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
