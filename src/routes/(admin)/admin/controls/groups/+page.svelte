<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const descriptionFor = (group: (typeof data.groups)[number], locale: string) =>
		group.translations.find((translation) => translation.locale === locale)?.description ?? '';
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_groups()}</h1>

<form
	method="POST"
	action="?/create"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input data-testid="group-slug" name="slug" required class="rounded border px-2 py-1" />
	</label>

	{#each data.locales as locale (locale)}
		<label class="grid gap-1 text-sm">
			{m.admin_name()} ({locale})
			<input
				data-testid="group-name-{locale}"
				name="name.{locale}"
				class="rounded border px-2 py-1"
			/>
		</label>

		<label class="grid gap-1 text-sm">
			{m.admin_description()} ({locale})
			<textarea
				data-testid="group-description-{locale}"
				name="description.{locale}"
				rows="2"
				class="rounded border px-2 py-1"></textarea>
		</label>
	{/each}

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
		<li class="p-4" data-testid="group-row-{group.slug}">
			<form method="POST" action="?/update" use:enhance class="flex flex-wrap items-end gap-3">
				<input type="hidden" name="id" value={group.id} />
				<span class="font-medium">{group.names[data.locale] ?? group.slug}</span>
				<span class="font-mono text-sm text-neutral-500">{group.slug}</span>

				{#each data.locales as locale (locale)}
					<label class="grid gap-1 text-sm">
						{locale}
						<input
							name="name.{locale}"
							value={group.names[locale] ?? ''}
							placeholder={m.admin_not_translated()}
							class="rounded border px-2 py-1"
						/>
					</label>

					<label class="grid gap-1 text-sm">
						{m.admin_description()} ({locale})
						<textarea
							name="description.{locale}"
							rows="2"
							placeholder={m.admin_not_translated()}
							class="rounded border px-2 py-1">{descriptionFor(group, locale)}</textarea
						>
					</label>
				{/each}

				<button class="rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
			</form>
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
