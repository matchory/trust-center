<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { PORTAL_SECTIONS } from '$lib/portal/sections';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<SectionHeading title={m.site_title()} description={m.portal_tagline()} />

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
