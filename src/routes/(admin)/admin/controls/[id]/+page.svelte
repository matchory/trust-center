<script lang="ts">
	import { enhance } from '$app/forms';
	import { CONTROL_STATUSES } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// One tab per enabled locale — the "not translated" state has to be visible,
	// not inferred from an empty field.
	let activeLocale = $state(data.locale);

	const translationFor = (locale: string) =>
		data.control.translations.find((translation) => translation.locale === locale) ?? null;
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.control.slug}</h1>
	<span data-testid="control-status-badge" class="rounded bg-neutral-100 px-2 py-0.5 text-sm"
		>{data.control.status}</span
	>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input name="slug" value={data.control.slug} class="rounded border px-2 py-1" />
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_group()}
		<select name="groupId" class="rounded border px-2 py-1">
			{#each data.groups as group (group.id)}
				<option value={group.id} selected={group.id === data.control.groupId}>
					{group.names[data.locale] ?? group.slug}
				</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_status()}
		<select data-testid="control-status" name="status" class="rounded border px-2 py-1">
			{#each CONTROL_STATUSES as status (status)}
				<option value={status} selected={status === data.control.status}>{status}</option>
			{/each}
		</select>
	</label>

	<label class="flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			name="published"
			data-testid="control-published"
			checked={data.control.published}
		/>
		{m.admin_published()}
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_evidence()}
		<select
			name="evidence"
			multiple
			size="5"
			data-testid="control-evidence"
			class="rounded border px-2 py-1"
		>
			{#each data.documents as doc (doc.id)}
				<option value={doc.id} selected={data.control.evidenceDocumentIds.includes(doc.id)}>
					{doc.titles[data.locale] ?? doc.slug}
				</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_position()}
		<input
			name="position"
			type="number"
			value={data.control.position}
			class="rounded border px-2 py-1"
		/>
	</label>

	<button
		data-testid="control-save-meta"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>

<div class="mb-3 flex gap-2 border-b">
	{#each data.locales as locale (locale)}
		<button
			type="button"
			data-testid="locale-tab-{locale}"
			onclick={() => (activeLocale = locale)}
			class="border-b-2 px-3 py-2 text-sm {activeLocale === locale
				? 'border-neutral-900 font-medium'
				: 'border-transparent text-neutral-500'}"
		>
			{locale}
			{#if !translationFor(locale)}
				<span class="ml-1 text-xs text-amber-700">•</span>
			{/if}
		</button>
	{/each}
</div>

{#each data.locales as locale (locale)}
	{#if locale === activeLocale}
		<form
			method="POST"
			action="?/saveTranslation"
			use:enhance
			class="mb-8 grid gap-3 rounded border bg-white p-4"
		>
			<input type="hidden" name="locale" value={locale} />

			<label class="grid gap-1 text-sm">
				{m.admin_title()}
				<input
					data-testid="translation-title-{locale}"
					name="title"
					value={translationFor(locale)?.title ?? ''}
					class="rounded border px-2 py-1"
				/>
			</label>

			<label class="grid gap-1 text-sm">
				{m.admin_description()}
				<textarea
					data-testid="translation-description-{locale}"
					name="description"
					rows="3"
					class="rounded border px-2 py-1">{translationFor(locale)?.description ?? ''}</textarea
				>
			</label>

			{#if form?.field === 'title' && form?.locale === locale}
				<p class="text-sm text-red-700">{m.admin_error_required()}</p>
			{/if}

			<button
				data-testid="translation-save-{locale}"
				class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
			>
				{m.admin_save()}
			</button>
		</form>
	{/if}
{/each}

<form method="POST" action="?/remove" use:enhance class="mt-10">
	<button
		data-testid="control-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
