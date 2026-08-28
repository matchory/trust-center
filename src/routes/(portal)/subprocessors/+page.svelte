<script lang="ts">
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Intl rather than a country-name table: it names any ISO 3166-1 alpha-2
	// code in the visitor's language, and it is built into the platform.
	const countryName = (code: string) =>
		new Intl.DisplayNames([data.locale], { type: 'region' }).of(code) ?? code;
</script>

<Seo
	title={m.nav_subprocessors()}
	description={m.subprocessors_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
/>

<SectionHeading title={m.nav_subprocessors()} description={m.subprocessors_intro()} />

{#if data.current.length === 0 && data.former.length === 0}
	<p data-testid="subprocessors-empty" class="text-neutral-600">{m.subprocessors_empty()}</p>
{/if}

{#snippet table(rows: typeof data.current, heading: string, testId: string)}
	<section class="mb-10" data-testid={testId}>
		<h2 class="mb-3 text-xl font-medium">{heading}</h2>

		<div class="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
			<table class="w-full text-sm">
				<thead class="border-b bg-neutral-50 text-left">
					<tr>
						<th class="p-3">{m.admin_name()}</th>
						<th class="p-3">{m.subprocessors_country()}</th>
						<th class="p-3">{m.subprocessors_region()}</th>
						<th class="p-3">{m.subprocessors_purpose()}</th>
						<th class="p-3">{m.subprocessors_data()}</th>
						<th class="p-3">{m.subprocessors_dpa()}</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each rows as row (row.id)}
						<tr data-testid="subprocessor-{row.slug}">
							<td class="p-3">
								<span class="font-medium">{row.name}</span>
								{#if row.isPurposeFallback}<FallbackNotice locale={row.purposeLocale} />{/if}
								<span class="block text-xs text-neutral-500">{row.legalEntity}</span>
								{#if row.startedAt}
									<span class="block text-xs text-neutral-500"
										>{m.subprocessors_since({ date: formatDate(row.startedAt, data.locale) })}</span
									>
								{/if}
								{#if row.endedAt}
									<span class="block text-xs text-neutral-500"
										>{m.subprocessors_until({ date: formatDate(row.endedAt, data.locale) })}</span
									>
								{/if}
							</td>
							<td class="p-3">{countryName(row.country)}</td>
							<td class="p-3">{row.region}</td>
							<td class="p-3">{row.purpose}</td>
							<td class="p-3">{row.dataCategories}</td>
							<td class="p-3">
								{#if row.dpaUrl}
									<a
										href={row.dpaUrl}
										rel="noreferrer noopener external"
										target="_blank"
										class="underline"
									>
										{m.subprocessors_dpa()}
									</a>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/snippet}

{#if data.current.length > 0}
	{@render table(data.current, m.subprocessors_current(), 'subprocessors-current')}
{/if}

{#if data.former.length > 0}
	{@render table(data.former, m.subprocessors_former(), 'subprocessors-former')}
{/if}
