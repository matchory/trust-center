<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import LocaleTabs from '$lib/components/admin/LocaleTabs.svelte';
	import { DOCUMENT_TIERS } from '$lib/content-types';
	import { formatBytes, formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const translationFor = (locale: string) =>
		data.document.translations.find((translation) => translation.locale === locale) ?? null;

	const filesFor = (locale: string) => data.document.files.filter((file) => file.locale === locale);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.document.slug}</h1>
	<span data-testid="document-status" class="rounded bg-neutral-100 px-2 py-0.5 text-sm"
		>{data.document.status}</span
	>

	<form method="POST" action="?/setStatus" use:enhance class="ml-auto flex gap-2">
		<input type="hidden" name="status" value="published" />
		<button
			data-testid="document-publish"
			class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
		>
			{m.admin_publish()}
		</button>
	</form>

	<form method="POST" action="?/setStatus" use:enhance>
		<input type="hidden" name="status" value="archived" />
		<button data-testid="document-archive" class="rounded border px-3 py-1.5 text-sm">
			{m.admin_archive()}
		</button>
	</form>
</div>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.document.slug} class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_category()}>
		<select name="categoryId" class="rounded border px-2 py-1">
			{#each data.categories as category (category.id)}
				<option value={category.id} selected={category.id === data.document.categoryId}>
					{category.names[data.locale] ?? category.slug}
				</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_tier()}>
		<select name="tier" class="rounded border px-2 py-1">
			{#each DOCUMENT_TIERS as tier (tier)}
				<option value={tier} selected={tier === data.document.tier}>{tier}</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_position()}>
		<input
			name="position"
			type="number"
			value={data.document.position}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<fieldset class="grid gap-1">
		<legend class="text-sm font-medium">{m.admin_document_groups()}</legend>
		{#each data.groups as group (group.id)}
			<label class="flex items-center gap-2 text-sm">
				<input
					data-testid="document-group-{group.slug}"
					type="checkbox"
					name="groupIds"
					value={group.id}
					checked={data.groupIds.includes(group.id)}
				/>
				{group.names[data.locale] ?? group.slug}
			</label>
		{/each}
		{#if data.groups.length === 0}
			<p class="text-sm text-neutral-500">{m.admin_no_entries()}</p>
		{/if}
	</fieldset>

	<button
		data-testid="document-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_save()}
	</button>
</form>

<LocaleTabs
	locales={data.locales}
	initial={data.locale}
	translated={(locale) => translationFor(locale) !== null}
>
	{#snippet children(locale)}
		<!-- Associated with the translation form by id rather than nested in it.
		     This pane also carries the upload and delete forms, and a <form>
		     inside a <form> is dropped by the parser — wrapping the tab strip
		     would silently disable uploading. -->
		<div class="mb-8 grid gap-3 rounded border bg-white p-4">
			<FormField label={m.admin_title()}>
				<input
					data-testid="translation-title-{locale}"
					form="document-translations"
					name="title.{locale}"
					value={translationFor(locale)?.title ?? ''}
					class="rounded border px-2 py-1"
				/>
			</FormField>

			<FormField label={m.admin_summary()}>
				<textarea
					data-testid="translation-summary-{locale}"
					form="document-translations"
					name="summary.{locale}"
					rows="3"
					class="rounded border px-2 py-1">{translationFor(locale)?.summary ?? ''}</textarea
				>
			</FormField>

			{#if form?.field === 'title' && form?.locale === locale}
				<p class="text-sm text-red-700">{m.admin_error_required()}</p>
			{/if}
		</div>

		<section class="rounded border bg-white p-4">
			<h2 class="mb-3 font-medium">{m.admin_file()} ({locale})</h2>

			<ul class="mb-4 divide-y text-sm">
				{#each filesFor(locale) as file (file.id)}
					<li class="flex flex-wrap items-center gap-3 py-2">
						<span class="font-mono">{file.filename}</span>
						<span class="text-neutral-500"
							>v{file.version} · {formatBytes(file.sizeBytes, data.locale)}</span
						>
						{#if file.validUntil}
							<span class="text-neutral-500">{formatDate(file.validUntil, data.locale)}</span>
						{/if}
						{#if file.isCurrent}<span class="rounded bg-emerald-50 px-2 text-emerald-800"
								>{m.documents_status_current()}</span
							>{/if}

						<form method="POST" action="?/deleteFile" use:enhance class="ml-auto">
							<input type="hidden" name="fileId" value={file.id} />
							<button class="text-red-700 underline">{m.admin_delete()}</button>
						</form>
					</li>
				{:else}
					<li class="py-2 text-neutral-500">{m.admin_no_entries()}</li>
				{/each}
			</ul>

			<form
				method="POST"
				action="?/uploadFile"
				enctype="multipart/form-data"
				use:enhance
				class="grid gap-3 sm:grid-cols-4 sm:items-end"
			>
				<input type="hidden" name="locale" value={locale} />

				<label class="grid gap-1 text-sm sm:col-span-2">
					{m.admin_file()}
					<input
						data-testid="file-input-{locale}"
						type="file"
						name="file"
						accept="application/pdf"
						required
					/>
				</label>

				<FormField label={m.admin_valid_from()}>
					<input type="date" name="validFrom" class="rounded border px-2 py-1" />
				</FormField>

				<FormField label={m.admin_valid_until()}>
					<input type="date" name="validUntil" class="rounded border px-2 py-1" />
				</FormField>

				{#if form?.field === 'file' && form?.locale === locale}
					<p class="text-sm text-red-700 sm:col-span-4">{form.message}</p>
				{/if}

				<button
					data-testid="file-upload-{locale}"
					class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
				>
					{m.admin_upload()}
				</button>
			</form>
		</section>
	{/snippet}
</LocaleTabs>

<form id="document-translations" method="POST" action="?/saveTranslations" use:enhance class="mb-8">
	<button data-testid="translation-save" class="rounded bg-neutral-900 px-3 py-1.5 text-white">
		{m.admin_save()}
	</button>
</form>

<form method="POST" action="?/remove" use:enhance class="mt-10">
	<button
		data-testid="document-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
