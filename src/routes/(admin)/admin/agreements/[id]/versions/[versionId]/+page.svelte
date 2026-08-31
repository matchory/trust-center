<script lang="ts">
	import { enhance } from '$app/forms';
	import AgreementBody from '$lib/components/AgreementBody.svelte';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let immutable = $derived(data.version.firstAcceptedAt !== null);
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
			<FormField label={`${m.admin_agreement_body()} (${locale})`}>
				<textarea
					data-testid="body-{locale}"
					name="body.{locale}"
					readonly={immutable}
					rows="8"
					class="w-full rounded border px-2 py-1 font-mono"
					>{data.bodies[locale]?.bodyMd ?? ''}</textarea
				>
			</FormField>

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

	<button data-testid="version-save" class="justify-self-start rounded border px-3 py-1.5 text-sm">
		{m.admin_save()}
	</button>
</form>

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
