<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="mb-6">
	<a
		href={localizePath('/admin/agreements', data.locale)}
		class="text-sm underline underline-offset-4">{m.nav_agreements()}</a
	>
	<h1 class="mt-1 text-2xl font-semibold">
		{data.template.names[data.locale] ?? data.template.slug}
	</h1>
</div>

<section class="mb-8 rounded border bg-white p-4 text-sm">
	{#if data.template.retiredAt}
		<p class="text-neutral-500">{m.admin_agreement_retired()}</p>
	{:else if data.template.effectiveVersionNumber !== null}
		<p data-testid="agreement-effective-version" class="text-green-700">
			{m.admin_agreement_effective({ version: data.template.effectiveVersionNumber })}
		</p>
	{:else}
		<p data-testid="agreement-no-effective-version" class="text-amber-700">
			{m.admin_agreement_no_effective_version()}
		</p>
		{#if data.template.blockedLocales.length > 0}
			<p class="mt-1 text-neutral-500">
				{m.admin_agreement_blocked_locales({ locales: data.template.blockedLocales.join(', ') })}
			</p>
		{/if}
	{/if}
</section>

<form
	method="POST"
	action="?/saveMeta"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_agreement_slug()}>
		<input
			name="slug"
			value={data.template.slug}
			required
			class="rounded border px-2 py-1 font-mono"
		/>
	</FormField>
	<button class="justify-self-start rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
</form>

<form
	method="POST"
	action="?/saveTranslations"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	{#each data.locales as locale (locale)}
		<FormField label={`${m.admin_agreement_name()} (${locale})`}>
			<input
				data-testid="agreement-name-{locale}"
				name="name.{locale}"
				value={data.template.names[locale] ?? ''}
				placeholder={m.admin_not_translated()}
				class="rounded border px-2 py-1"
			/>
		</FormField>
		<FormField label={`${m.admin_agreement_description()} (${locale})`}>
			<textarea
				data-testid="agreement-description-{locale}"
				name="description.{locale}"
				rows="2"
				class="rounded border px-2 py-1">{data.template.descriptions[locale] ?? ''}</textarea
			>
		</FormField>
	{/each}
	<button
		data-testid="agreement-save-translations"
		class="justify-self-start rounded border px-3 py-1.5 text-sm"
	>
		{m.admin_save()}
	</button>
</form>

<section class="mb-8 rounded border bg-white p-4">
	<div class="mb-2 flex items-center gap-3">
		<h2 class="font-medium">{m.admin_agreement_versions()}</h2>
		{#if !data.template.retiredAt}
			<form method="POST" action="?/createVersion" use:enhance class="ml-auto">
				<button data-testid="agreement-new-version" class="rounded border px-3 py-1.5 text-sm">
					{m.admin_agreement_new_version()}
				</button>
			</form>
		{/if}
	</div>
	{#if data.template.versions.length > 0}
		<ul class="divide-y text-sm">
			{#each data.template.versions as version (version.id)}
				<li class="flex flex-wrap items-center gap-3 py-2">
					<a
						href={localizePath(
							`/admin/agreements/${data.template.id}/versions/${version.id}`,
							data.locale
						)}
						data-testid="version-{version.version}"
						class="font-mono underline underline-offset-4"
					>
						v{version.version}
					</a>
					<span class="text-neutral-500">{version.locales.join(', ') || '—'}</span>
					{#if version.retiredAt}
						<span class="text-neutral-500">{m.admin_agreement_retired()}</span>
					{:else if version.effectiveFrom}
						<span class="text-green-700"
							>{m.admin_agreement_effective({ version: version.version })}</span
						>
					{:else}
						<span class="text-neutral-500">{m.admin_agreement_draft()}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if !data.template.retiredAt}
	<form method="POST" action="?/retire" use:enhance>
		<button
			data-testid="agreement-retire"
			class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
			onclick={(event) => {
				if (!confirm(m.admin_agreement_retire_confirm())) event.preventDefault();
			}}
		>
			{m.admin_agreement_retire()}
		</button>
	</form>
{/if}
