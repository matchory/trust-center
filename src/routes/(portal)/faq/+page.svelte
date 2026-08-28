<script lang="ts">
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<SectionHeading title={m.nav_faq()} description={m.faq_intro()} />

{#if data.groups.length === 0}
	<p data-testid="faq-empty" class="text-neutral-600">{m.faq_empty()}</p>
{:else}
	{#each data.groups as group (group.category)}
		<section class="mb-10" data-testid="faq-category-{group.category}">
			<h2 class="mb-3 text-xl font-medium">{group.category}</h2>

			<dl class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each group.answers as item (item.id)}
					<div class="p-4" data-testid="answer-{item.slug}" id={item.slug}>
						<dt class="font-medium">
							{item.question}
							{#if item.isTranslationFallback}
								<FallbackNotice locale={item.translationLocale} />
							{/if}
						</dt>
						<!-- Plain text, never markdown: the FAQ is the surface most likely
						     to be pasted into from a questionnaire, and rendering markup
						     would mean shipping a sanitiser or an XSS hole. -->
						<dd class="mt-1 whitespace-pre-line text-neutral-600">{item.answer}</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/each}
{/if}
