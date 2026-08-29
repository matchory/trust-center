<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import LocaleTabs from '$lib/components/admin/LocaleTabs.svelte';
	import { UPDATE_KINDS } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const translationFor = (locale: string) =>
		data.post.translations.find((translation) => translation.locale === locale) ?? null;

	/** `<input type="datetime-local">` wants YYYY-MM-DDTHH:mm, no zone suffix. */
	const dateTimeValue = (date: Date | null) => (date ? date.toISOString().slice(0, 16) : '');
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.post.slug}</h1>
	<span data-testid="update-kind-badge" class="rounded bg-neutral-100 px-2 py-0.5 text-sm"
		>{data.post.kind}</span
	>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.post.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_kind()}>
		<select data-testid="update-kind" name="kind" class="rounded border px-2 py-1">
			{#each UPDATE_KINDS as kind (kind)}
				<option value={kind} selected={kind === data.post.kind}>{kind}</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_published_at()}>
		<input
			type="datetime-local"
			name="publishedAt"
			data-testid="update-published-at"
			value={dateTimeValue(data.post.publishedAt)}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<button
		data-testid="update-save-meta"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>

<LocaleTabs
	locales={data.locales}
	initial={data.locale}
	translated={(locale) => translationFor(locale) !== null}
>
	{#snippet children(locale)}
		<form
			method="POST"
			action="?/saveTranslation"
			use:enhance
			class="mb-8 grid gap-3 rounded border bg-white p-4"
		>
			<input type="hidden" name="locale" value={locale} />

			<FormField label={m.admin_title()}>
				<input
					data-testid="translation-title-{locale}"
					name="title"
					value={translationFor(locale)?.title ?? ''}
					class="rounded border px-2 py-1"
				/>
			</FormField>

			<FormField label={m.admin_body()}>
				<textarea
					data-testid="translation-body-{locale}"
					name="body"
					rows="5"
					class="rounded border px-2 py-1">{translationFor(locale)?.body ?? ''}</textarea
				>
			</FormField>

			{#if (form?.field === 'title' || form?.field === 'body') && form?.locale === locale}
				<p class="text-sm text-red-700">{m.admin_error_required()}</p>
			{/if}

			<button
				data-testid="translation-save-{locale}"
				class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
			>
				{m.admin_save()}
			</button>
		</form>
	{/snippet}
</LocaleTabs>

<form method="POST" action="?/remove" use:enhance class="mt-10">
	<button
		data-testid="update-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
