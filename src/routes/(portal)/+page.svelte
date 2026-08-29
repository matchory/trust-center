<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { fileValidity, formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { PORTAL_SECTIONS } from '$lib/portal/sections';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.site_title()}
	description={m.portal_tagline()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
/>

<SectionHeading title={m.site_title()} description={m.portal_tagline()} />

{#if data.certifications.length > 0}
	<section class="mb-12" data-testid="certifications">
		<h2 class="mb-4 text-xl font-medium">{m.nav_certifications()}</h2>
		<ul class="grid gap-4 sm:grid-cols-2">
			{#each data.certifications as item (item.id)}
				{@const validity = fileValidity({ validFrom: item.validFrom, validUntil: item.validUntil })}
				<li
					data-testid="certification-{item.slug}"
					class="rounded-lg border border-neutral-200 bg-white p-5"
				>
					<div class="flex flex-wrap items-baseline gap-2">
						<span class="font-medium">{item.framework}</span>
						<Badge
							tone={validity === 'expired' ? 'danger' : validity === 'expiring' ? 'warn' : 'ok'}
						>
							{validity === 'expired'
								? m.documents_status_expired()
								: validity === 'expiring'
									? m.documents_status_expiring()
									: m.documents_status_current()}
						</Badge>
						{#if item.isScopeFallback}<FallbackNotice locale={item.scopeLocale} />{/if}
					</div>

					<p class="mt-1 text-sm text-neutral-600">{item.scope}</p>
					<p class="mt-1 text-sm text-neutral-500">
						{m.certifications_issued_by({ issuer: item.issuer })}
					</p>

					{#if item.validFrom && item.validUntil}
						<p class="text-sm text-neutral-500">
							{m.certifications_valid({
								from: formatDate(item.validFrom, data.locale),
								until: formatDate(item.validUntil, data.locale)
							})}
						</p>
					{/if}

					{#if item.certificateFileId}
						<a
							data-testid="certificate-{item.slug}"
							href="/api/documents/{item.certificateFileId}"
							class="mt-2 inline-block text-sm underline underline-offset-4"
						>
							{m.certifications_certificate()}
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if PORTAL_SECTIONS.length === 0}
	<p data-testid="no-sections" class="text-neutral-600">{m.portal_no_sections()}</p>
{:else}
	<ul class="grid gap-4 sm:grid-cols-2">
		{#each PORTAL_SECTIONS as section (section.path)}
			<li>
				<a
					href={localizePath(section.path, data.locale)}
					class="block rounded-lg border border-neutral-200 bg-white p-5 hover:border-neutral-400"
				>
					<span class="font-medium">{section.label()}</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
