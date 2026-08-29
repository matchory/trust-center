<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { fileValidity, formatBytes, formatDate, type FileValidity } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TONE: Record<FileValidity, 'ok' | 'warn' | 'danger' | 'neutral'> = {
		current: 'ok',
		expiring: 'warn',
		expired: 'danger',
		'not-yet-valid': 'neutral'
	};

	const LABEL: Record<FileValidity, () => string> = {
		current: () => m.documents_status_current(),
		expiring: () => m.documents_status_expiring(),
		expired: () => m.documents_status_expired(),
		'not-yet-valid': () => m.documents_status_not_yet_valid()
	};
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.nav_documents()}
	description={m.documents_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
/>

<SectionHeading title={m.nav_documents()} description={m.documents_intro()} />

{#if data.categories.length === 0}
	<p data-testid="documents-empty" class="text-neutral-600">{m.documents_empty()}</p>
{:else}
	{#each data.categories as category (category.id)}
		<section class="mb-10" data-testid="category-{category.slug}">
			<h2 class="mb-3 flex items-baseline gap-2 text-xl font-medium">
				{category.name}
				{#if category.isNameFallback}<FallbackNotice locale={category.nameLocale} />{/if}
			</h2>

			<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each category.documents as doc (doc.id)}
					{@const validity = doc.file ? fileValidity(doc.file) : null}
					<li
						class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
						id={doc.slug}
						data-testid="document-{doc.slug}"
					>
						<div class="min-w-0 flex-1">
							<p class="font-medium">
								{doc.title}
								{#if doc.isTranslationFallback}
									<FallbackNotice locale={doc.translationLocale} />
								{/if}
							</p>
							{#if doc.summary}<p class="mt-1 text-sm text-neutral-600">{doc.summary}</p>{/if}
						</div>

						{#if doc.file && validity}
							<Badge tone={TONE[validity]}>{LABEL[validity]()}</Badge>
							<span class="text-sm text-neutral-500">
								{m.documents_version({ version: doc.file.version })} ·
								{formatBytes(doc.file.sizeBytes, data.locale)}
								{#if doc.file.validUntil}
									· {m.documents_valid_until({
										date: formatDate(doc.file.validUntil, data.locale)
									})}
								{/if}
							</span>
							{#if doc.isFileFallback}<FallbackNotice locale={doc.file.locale} />{/if}
							<a
								data-testid="download-{doc.slug}"
								href="/api/documents/{doc.file.id}"
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
		</section>
	{/each}
{/if}
