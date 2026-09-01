<script lang="ts">
	import { enhance } from '$app/forms';
	import AgreementBody from '$lib/components/AgreementBody.svelte';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let immutable = $derived(data.version.firstAcceptedAt !== null);

	// What each locale's editor holds. Seeded here rather than in the effect
	// below so the server renders the stored body: effects do not run during
	// SSR, and an editor that only fills in after hydration would make the page
	// depend on JavaScript to show what it is editing. Capturing the initial
	// value is the intent — the effect owns every later change.
	// svelte-ignore state_referenced_locally
	let bodies = $state<Record<string, string>>(
		Object.fromEntries(data.locales.map((locale) => [locale, data.bodies[locale]?.bodyMd ?? '']))
	);

	// Replaced wholesale when the load changes, and when an import returns. The
	// textarea is bound to this rather than reading `data` directly, because an
	// import result has to reach it without a save having happened.
	$effect(() => {
		for (const locale of data.locales) {
			bodies[locale] = data.bodies[locale]?.bodyMd ?? '';
		}
	});

	$effect(() => {
		const imported = form && 'imported' in form ? form.imported : null;
		if (imported) bodies[imported.locale] = imported.markdown;
	});
</script>

<div class="mb-6">
	<a
		href={localizePath(`/admin/agreements/${data.template.id}`, data.locale)}
		class="text-sm underline underline-offset-4"
	>
		{data.template.names[data.locale] ?? data.template.slug}
	</a>
	<h1 class="mt-1 text-2xl font-semibold">
		{m.admin_agreement_version_heading({ version: data.version.version })}
	</h1>
</div>

<section class="mb-6 rounded border bg-white p-4 text-sm">
	{#if data.version.retiredAt}
		<p data-testid="version-status" class="text-neutral-500">{m.admin_agreement_retired()}</p>
	{:else if data.version.effectiveFrom}
		<p data-testid="version-status" class="text-green-700">
			{m.admin_agreement_effective({ version: data.version.version })}
		</p>
	{:else}
		<p data-testid="version-status" class="text-neutral-500">{m.admin_agreement_draft()}</p>
	{/if}
	{#if immutable}
		<p class="mt-1 text-amber-700">{m.admin_agreement_version_immutable()}</p>
	{/if}
</section>

<form
	method="POST"
	action="?/saveBody"
	use:enhance
	class="mb-6 grid gap-6 rounded border bg-white p-4"
>
	{#each data.locales as locale (locale)}
		<div>
			<div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
				<label for="import-{locale}">{m.admin_agreement_import()}</label>
				<input
					id="import-{locale}"
					data-testid="import-file-{locale}"
					form="import-form-{locale}"
					type="file"
					name="file"
					accept=".pdf,.docx"
					disabled={immutable}
				/>
				<button
					data-testid="import-submit-{locale}"
					form="import-form-{locale}"
					class="rounded border px-3 py-1.5"
					disabled={immutable}>{m.admin_agreement_import_submit()}</button
				>
			</div>

			<FormField label={`${m.admin_agreement_body()} (${locale})`}>
				<textarea
					data-testid="body-{locale}"
					name="body.{locale}"
					readonly={immutable}
					rows="8"
					bind:value={bodies[locale]}
					class="w-full rounded border px-2 py-1 font-mono"></textarea>
			</FormField>

			{#if form && 'imported' in form && form.imported?.locale === locale && form.imported.dropped.length > 0}
				<p data-testid="import-dropped-{locale}" class="mt-2 text-sm text-amber-700">
					{m.admin_agreement_import_dropped({ types: form.imported.dropped.join(', ') })}
				</p>
			{/if}

			{#if data.bodies[locale]}
				<div class="mt-2 rounded border border-dashed p-3">
					<h3 class="text-xs font-medium tracking-wide text-neutral-500 uppercase">
						{m.admin_agreement_preview()}
					</h3>
					<AgreementBody root={data.bodies[locale].root} />
				</div>
			{/if}
		</div>
	{/each}

	{#if form?.field === 'body'}
		{#if form.message === 'immutable'}
			<p class="text-sm text-amber-700">{m.admin_agreement_version_immutable()}</p>
		{:else}
			<p data-testid="body-not-in-subset" class="text-sm text-red-700">
				{m.admin_agreement_body_not_in_subset({ nodeType: form.message ?? '' })}
			</p>
		{/if}
	{/if}

	{#if form?.field === 'import'}
		{#if form.message === 'immutable'}
			<p class="text-sm text-amber-700">{m.admin_agreement_version_immutable()}</p>
		{:else if form.message === 'no-text'}
			<p data-testid="import-error" class="text-sm text-red-700">
				{m.admin_agreement_import_no_text()}
			</p>
		{:else}
			<p data-testid="import-error" class="text-sm text-red-700">
				{m.admin_agreement_import_failed({ reason: form.message ?? '' })}
			</p>
		{/if}
	{/if}

	<button data-testid="version-save" class="justify-self-start rounded border px-3 py-1.5 text-sm">
		{m.admin_save()}
	</button>
</form>

<!--
	One bare form per locale for the import controls to post to. They cannot sit
	inside the `saveBody` form — nested forms are invalid HTML and the browser
	drops the inner one — so the controls reach them by `form=` instead. Its id
	is not the file input's: `form=` resolves against every element id, so a form
	sharing an id with the input would silently associate the button with
	nothing, and the button would do nothing at all when clicked.
-->
{#each data.locales as locale (locale)}
	<form
		id="import-form-{locale}"
		method="POST"
		action="?/import"
		enctype="multipart/form-data"
		use:enhance
	>
		<input type="hidden" name="locale" value={locale} />
	</form>
{/each}

<form method="POST" action="?/publish" use:enhance>
	<button
		data-testid="version-publish"
		class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
	>
		{m.admin_agreement_publish()}
	</button>
</form>

{#if form?.field === 'publish'}
	{#if form.message === 'incomplete'}
		<p data-testid="version-incomplete" class="mt-3 text-sm text-red-700">
			{m.admin_agreement_version_incomplete()}
		</p>
	{:else if form.message === 'already-published'}
		<p data-testid="version-already-published" class="mt-3 text-sm text-red-700">
			{m.admin_agreement_version_already_published()}
		</p>
	{/if}
{/if}
