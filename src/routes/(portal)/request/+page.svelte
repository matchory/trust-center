<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.request_title()}
	description={m.request_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

{#if form?.submitted}
	<SectionHeading title={m.request_submitted_title()} />
	<p data-testid="request-submitted" class="max-w-prose text-neutral-700">
		{m.request_submitted_body()}
	</p>
{:else}
	<SectionHeading title={m.request_title()} description={m.request_intro()} />

	<form method="POST" use:enhance class="max-w-xl space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_email()}</span>
			<input
				name="email"
				type="email"
				required
				autocomplete="email"
				class="w-full rounded border px-3 py-2"
			/>
			{#if form?.field === 'email'}
				<p class="mt-1 text-sm text-red-700">{m.request_error_email()}</p>
			{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_name()}</span>
			<input name="name" required autocomplete="name" class="w-full rounded border px-3 py-2" />
			{#if form?.field === 'name'}
				<p class="mt-1 text-sm text-red-700">{m.request_error_required()}</p>
			{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_company()}</span>
			<input
				name="company"
				required
				autocomplete="organization"
				class="w-full rounded border px-3 py-2"
			/>
			{#if form?.field === 'company'}
				<p class="mt-1 text-sm text-red-700">{m.request_error_required()}</p>
			{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_justification()}</span>
			<textarea name="justification" rows="3" class="w-full rounded border px-3 py-2"></textarea>
		</label>

		<fieldset>
			<legend class="mb-2 text-sm font-medium">{m.request_documents()}</legend>

			<label class="mb-2 flex items-center gap-2">
				<input type="checkbox" name="allRequestTier" />
				<span>{m.request_all_restricted()}</span>
			</label>

			{#each data.documents as doc (doc.id)}
				<label class="flex items-center gap-2">
					<input type="checkbox" name="documentIds" value={doc.id} />
					<span>{doc.title}</span>
				</label>
			{:else}
				<p class="text-sm text-neutral-600">{m.request_none_available()}</p>
			{/each}

			{#if form?.field === 'throttled'}
				<p class="mt-2 text-sm text-red-700">{m.request_error_throttled()}</p>
			{/if}
		</fieldset>

		<button type="submit" class="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700">
			{m.request_submit()}
		</button>
	</form>
{/if}
