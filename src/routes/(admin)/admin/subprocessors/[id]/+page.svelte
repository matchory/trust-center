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
		data.subprocessor.translations.find((translation) => translation.locale === locale) ?? null;

	/** `<input type="date">` wants YYYY-MM-DD, and only ever means a UTC day here. */
	const dateValue = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : '');
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.subprocessor.name}</h1>
	<span class="font-mono text-sm text-neutral-500">{data.subprocessor.slug}</span>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.subprocessor.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_name()}>
		<input name="name" value={data.subprocessor.name} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_legal_entity()}>
		<input
			name="legalEntity"
			value={data.subprocessor.legalEntity}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.subprocessors_country()}>
		<input
			name="country"
			maxlength="2"
			value={data.subprocessor.country}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.subprocessors_region()}>
		<input name="region" value={data.subprocessor.region} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_hosting_provider()}>
		<input
			name="hostingProvider"
			value={data.subprocessor.hostingProvider ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_dpa_url()}>
		<input
			name="dpaUrl"
			type="url"
			value={data.subprocessor.dpaUrl ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_started_at()}>
		<input
			type="date"
			name="startedAt"
			value={dateValue(data.subprocessor.startedAt)}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_ended_at()}>
		<input
			type="date"
			name="endedAt"
			data-testid="subprocessor-ended-at"
			value={dateValue(data.subprocessor.endedAt)}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<label class="flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			name="published"
			data-testid="subprocessor-published"
			checked={data.subprocessor.published}
		/>
		{m.admin_published()}
	</label>

	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.subprocessor.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<button
		data-testid="subprocessor-save-meta"
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

			<FormField label={m.subprocessors_purpose()}>
				<textarea
					data-testid="translation-purpose-{locale}"
					name="purpose"
					rows="2"
					class="rounded border px-2 py-1">{translationFor(locale)?.purpose ?? ''}</textarea
				>
			</FormField>

			<FormField label={m.subprocessors_data()}>
				<textarea
					data-testid="translation-datacategories-{locale}"
					name="dataCategories"
					rows="2"
					class="rounded border px-2 py-1">{translationFor(locale)?.dataCategories ?? ''}</textarea
				>
			</FormField>

			{#if (form?.field === 'purpose' || form?.field === 'dataCategories') && form?.locale === locale}
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
		data-testid="subprocessor-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
