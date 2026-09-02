<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import LocaleTabs from '$lib/components/admin/LocaleTabs.svelte';
	import { ANSWER_VISIBILITIES } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const translationFor = (locale: string) =>
		data.answer.translations.find((translation) => translation.locale === locale) ?? null;
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.answer.slug}</h1>
	<span data-testid="answer-visibility-badge" class="rounded bg-neutral-100 px-2 py-0.5 text-sm"
		>{data.answer.visibility}</span
	>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.answer.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_category()}>
		<input name="category" value={data.answer.category} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_visibility()}>
		<select data-testid="answer-visibility" name="visibility" class="rounded border px-2 py-1">
			{#each ANSWER_VISIBILITIES as visibility (visibility)}
				<option value={visibility} selected={visibility === data.answer.visibility}
					>{visibility}</option
				>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.answer.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<button
		data-testid="answer-save-meta"
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
				<FormField label={m.admin_question()}>
					<input
						data-testid="translation-question-{locale}"
						name="question.{locale}"
						value={translationFor(locale)?.question ?? ''}
						class="rounded border px-2 py-1"
					/>
				</FormField>

				<FormField label={m.admin_answer()}>
					<textarea
						data-testid="translation-answer-{locale}"
						name="answer.{locale}"
						rows="5"
						class="rounded border px-2 py-1">{translationFor(locale)?.answer ?? ''}</textarea
					>
				</FormField>

				{#if (form?.field === 'question' || form?.field === 'answer') && form?.locale === locale}
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
		data-testid="answer-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
