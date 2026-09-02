<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { UPDATE_KINDS } from '$lib/content-types';
	import { endonym } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import { updateKindLabel } from '$lib/portal/update-kinds';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<!-- Same reasoning as the confirm page: the layout emits no default robots
     directive, and this URL carries a permanent credential in its query
     string, so it is the last page in the portal that should be indexable. -->
<Seo
	baseUrl={data.baseUrl}
	title={m.manage_title()}
	description={m.manage_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

{#if data.gone}
	<SectionHeading title={m.manage_gone_title()} />
	<p data-testid="manage-gone" class="max-w-prose text-neutral-700">{m.manage_gone_body()}</p>
{:else}
	<SectionHeading title={m.manage_title()} description={m.manage_intro()} />

	<form method="POST" action="?/save" use:enhance class="max-w-xl space-y-4">
		<input type="hidden" name="token" value={data.token} />

		<fieldset>
			<legend class="mb-1 block text-sm font-medium">{m.subscribe_topics()}</legend>
			{#each UPDATE_KINDS as topic (topic)}
				<label class="flex items-center gap-2 py-1">
					<input
						type="checkbox"
						name="topics"
						value={topic}
						data-testid="manage-topic-{topic}"
						checked={data.topics.includes(topic)}
					/>
					<span>{updateKindLabel(topic)}</span>
				</label>
			{/each}
			{#if form?.field === 'topics'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_topics()}</p>
			{/if}
		</fieldset>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.manage_language()}</span>
			<select name="locale" data-testid="manage-locale" class="rounded border px-2 py-1">
				{#each data.availableLocales as locale (locale)}
					<option value={locale} selected={locale === data.selectedLocale}>{endonym(locale)}</option
					>
				{/each}
			</select>
		</label>

		<button data-testid="manage-save" class="rounded bg-neutral-900 px-3 py-1.5 text-white"
			>{m.manage_save()}</button
		>
	</form>

	<form method="POST" action="?/unsubscribe" use:enhance class="mt-8">
		<input type="hidden" name="token" value={data.token} />
		<button data-testid="manage-unsubscribe" class="rounded border px-3 py-1.5 text-red-700"
			>{m.manage_unsubscribe()}</button
		>
	</form>
{/if}
