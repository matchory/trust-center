<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.access_title()}
	description={m.access_intro({ expiresAt: '' })}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

<SectionHeading
	title={m.access_title()}
	description={data.expiresAt
		? m.access_intro({ expiresAt: formatDate(data.expiresAt, data.locale) })
		: undefined}
/>

{#if data.documents.length === 0}
	<!-- Also what a requester whose request is still pending sees: there is
	     nothing to show them yet, and the mail tells them when there is. -->
	<p data-testid="access-empty" class="max-w-prose text-neutral-700">{m.access_empty()}</p>
{:else}
	<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
		{#each data.documents as doc (doc.documentId)}
			<li
				class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
				data-testid="access-document-{doc.slug}"
			>
				<div class="min-w-0 flex-1">
					<p class="font-medium">{doc.title}</p>
					{#if doc.summary}<p class="mt-1 text-sm text-neutral-600">{doc.summary}</p>{/if}
				</div>

				{#if doc.fileId}
					<span class="text-sm text-neutral-500">
						{m.documents_version({ version: doc.version ?? 0 })}
					</span>
					<a
						data-testid="access-download-{doc.slug}"
						href="/api/documents/{doc.fileId}"
						class="rounded bg-[var(--tc-primary,#171717)] px-3 py-1.5 text-sm font-medium text-white"
					>
						{m.documents_download()}
					</a>
				{:else}
					<span class="text-sm text-neutral-400">{m.documents_no_file()}</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
