<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import LocaleTabs from '$lib/components/admin/LocaleTabs.svelte';
	import { CONTROL_STATUSES } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

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
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.control.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_group()}>
		<select name="groupId" class="rounded border px-2 py-1">
			{#each data.groups as group (group.id)}
				<option value={group.id} selected={group.id === data.control.groupId}>
					{group.names[data.locale] ?? group.slug}
				</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_status()}>
		<select data-testid="control-status" name="status" class="rounded border px-2 py-1">
			{#each CONTROL_STATUSES as status (status)}
				<option value={status} selected={status === data.control.status}>{status}</option>
			{/each}
		</select>
	</FormField>

	<label class="flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			name="published"
			data-testid="control-published"
			checked={data.control.published}
		/>
		{m.admin_published()}
	</label>

	<FormField label={m.admin_evidence()}>
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
	</FormField>

	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.control.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<button
		data-testid="control-save-meta"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>

<form method="POST" action="?/saveTranslations" use:enhance class="mb-8">
	<LocaleTabs
		locales={data.locales}
		initial={data.locale}
		translated={(locale) => translationFor(locale) !== null}
	>
		{#snippet children(locale)}
			<div class="grid gap-3 rounded border bg-white p-4">
				<FormField label={m.admin_title()}>
					<input
						data-testid="translation-title-{locale}"
						name="title.{locale}"
						value={translationFor(locale)?.title ?? ''}
						class="rounded border px-2 py-1"
					/>
				</FormField>

				<FormField label={m.admin_description()}>
					<textarea
						data-testid="translation-description-{locale}"
						name="description.{locale}"
						rows="3"
						class="rounded border px-2 py-1">{translationFor(locale)?.description ?? ''}</textarea
					>
				</FormField>

				{#if form?.field === 'title' && form?.locale === locale}
					<p class="text-sm text-red-700">{m.admin_error_required()}</p>
				{/if}
			</div>
		{/snippet}
	</LocaleTabs>

	<button data-testid="translation-save" class="mt-3 rounded bg-neutral-900 px-3 py-1.5 text-white">
		{m.admin_save()}
	</button>
</form>

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
