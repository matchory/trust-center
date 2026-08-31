<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.agreements_title()}
	description={m.agreements_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

<SectionHeading title={m.agreements_title()} description={m.agreements_intro()} />

{#if data.agreements.length === 0}
	<p data-testid="agreements-none" class="max-w-prose text-neutral-700">{m.agreements_none()}</p>
{:else}
	<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
		{#each data.agreements as agreement (agreement.templateId)}
			<li
				class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
				data-testid="agreement-{agreement.slug}"
			>
				<div class="min-w-0 flex-1">
					<p class="font-medium">{agreement.name ?? agreement.slug}</p>
					{#if agreement.description}
						<p class="mt-1 text-sm text-neutral-600">{agreement.description}</p>
					{/if}
				</div>

				<a
					href={localizePath(`/access/agreements/${agreement.templateId}`, data.locale)}
					data-testid="agreement-open-{agreement.slug}"
					class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
				>
					{m.agreement_accept()}
				</a>
			</li>
		{/each}
	</ul>
{/if}
