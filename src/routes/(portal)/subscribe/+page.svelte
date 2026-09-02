<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { UPDATE_KINDS } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import { updateKindLabel } from '$lib/portal/update-kinds';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.subscribe_title()}
	description={m.subscribe_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

{#if form?.submitted}
	<SectionHeading title={m.subscribe_submitted_title()} />
	<p data-testid="subscribe-submitted" class="max-w-prose text-neutral-700">
		{m.subscribe_submitted_body()}
	</p>
{:else}
	<SectionHeading title={m.subscribe_title()} description={m.subscribe_intro()} />

	<form method="POST" use:enhance class="max-w-xl space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.subscribe_email()}</span>
			<input
				name="email"
				type="email"
				required
				autocomplete="email"
				data-testid="subscribe-email"
				class="w-full rounded border px-3 py-2"
			/>
			{#if form?.field === 'email'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_email()}</p>
			{/if}
		</label>

		<fieldset>
			<legend class="mb-1 block text-sm font-medium">{m.subscribe_topics()}</legend>
			{#each UPDATE_KINDS as topic (topic)}
				<label class="flex items-center gap-2 py-1">
					<input
						type="checkbox"
						name="topics"
						value={topic}
						data-testid="subscribe-topic-{topic}"
					/>
					<span>{updateKindLabel(topic)}</span>
				</label>
			{/each}
			{#if form?.field === 'topics'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_topics()}</p>
			{/if}
		</fieldset>

		{#if form?.field === 'throttled'}
			<p data-testid="subscribe-throttled" class="text-sm text-red-700">
				{m.subscribe_error_throttled()}
			</p>
		{/if}

		<button data-testid="subscribe-submit" class="rounded bg-neutral-900 px-3 py-1.5 text-white"
			>{m.subscribe_submit()}</button
		>
	</form>
{/if}
