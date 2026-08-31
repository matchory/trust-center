<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
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

{#if data.outstanding.length > 0}
	<!-- §9.1: one step is left, said where the requester actually looks. The
	     approval mail says it too, but a mailbox is not where somebody goes when
	     they wonder why their documents are not here. -->
	<p
		data-testid="grant-pending-acceptance"
		class="max-w-prose rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
	>
		{m.access_pending_acceptance({ count: data.outstanding.length })}
		<a
			data-testid="access-open-agreements"
			href={localizePath('/access/agreements', data.locale)}
			class="font-medium underline">{m.agreements_title()}</a
		>
	</p>
{/if}

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
						href={localizePath(`/access/documents/${doc.fileId}`, data.locale)}
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

{#if data.records.length > 0}
	<!-- §10.3: the record reaches them by mail, and it is also here — a mailbox
	     they no longer have is not where evidence of a contract should live. -->
	<SectionHeading title={m.access_records_title()} />

	<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
		{#each data.records as record (record.acceptanceId)}
			<li
				class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
				data-testid="access-record-{record.slug}"
			>
				<div class="min-w-0 flex-1">
					<p class="font-medium">{record.name}</p>
					<p class="mt-1 text-sm text-neutral-600">
						{m.access_record_accepted_at({
							acceptedAt: formatDate(record.acceptedAt, data.locale)
						})}
					</p>
				</div>

				<span class="text-sm text-neutral-500">
					{m.documents_version({ version: record.version })}
				</span>
				<a
					data-testid="access-record-download-{record.slug}"
					href={localizePath(`/access/records/${record.acceptanceId}`, data.locale)}
					class="rounded border border-neutral-300 px-3 py-1.5 text-sm font-medium"
				>
					{m.access_record_link()}
				</a>
			</li>
		{/each}
	</ul>
{/if}
