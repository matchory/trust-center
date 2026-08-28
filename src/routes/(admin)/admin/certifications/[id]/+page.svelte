<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import LocaleTabs from '$lib/components/admin/LocaleTabs.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// One tab per enabled locale — the "not translated" state has to be visible,
	// not inferred from an empty field.
	let activeLocale = $state(data.locale);

	const translationFor = (locale: string) =>
		data.certification.translations.find((translation) => translation.locale === locale) ?? null;

	/** `<input type="date">` wants YYYY-MM-DD, and only ever means a UTC day here. */
	const dateValue = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : '');
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.certification.framework}</h1>
	<span class="font-mono text-sm text-neutral-500">{data.certification.slug}</span>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.certification.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_framework()}>
		<input name="framework" value={data.certification.framework} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_issuer()}>
		<input name="issuer" value={data.certification.issuer} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_valid_from()}>
		<input
			type="date"
			name="validFrom"
			value={dateValue(data.certification.validFrom)}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_valid_until()}>
		<input
			type="date"
			name="validUntil"
			value={dateValue(data.certification.validUntil)}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_certificate()}>
		<select
			name="certificateDocumentId"
			data-testid="certification-document"
			class="rounded border px-2 py-1"
		>
			<option value="">—</option>
			{#each data.documents as doc (doc.id)}
				<option value={doc.id} selected={doc.id === data.certification.certificateDocumentId}>
					{doc.titles[data.locale] ?? doc.slug}
				</option>
			{/each}
		</select>
	</FormField>

	<label class="flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			name="published"
			data-testid="certification-published"
			checked={data.certification.published}
		/>
		{m.admin_published()}
	</label>

	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.certification.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<button
		data-testid="certification-save-meta"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>

<LocaleTabs
	locales={data.locales}
	bind:active={activeLocale}
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

			<FormField label={m.admin_scope()}>
				<textarea
					data-testid="translation-scope-{locale}"
					name="scope"
					rows="3"
					class="rounded border px-2 py-1">{translationFor(locale)?.scope ?? ''}</textarea
				>
			</FormField>

			{#if form?.field === 'scope' && form?.locale === locale}
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
		data-testid="certification-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
