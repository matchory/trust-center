<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import type { ControlStatus } from '$lib/content-types';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TONE: Record<ControlStatus, 'ok' | 'warn' | 'neutral'> = {
		implemented: 'ok',
		in_progress: 'warn',
		planned: 'neutral',
		not_applicable: 'neutral'
	};

	const LABEL: Record<ControlStatus, () => string> = {
		implemented: () => m.control_status_implemented(),
		in_progress: () => m.control_status_in_progress(),
		planned: () => m.control_status_planned(),
		not_applicable: () => m.control_status_not_applicable()
	};
</script>

<SectionHeading title={m.nav_controls()} description={m.controls_intro()} />

{#if data.groups.length === 0}
	<p data-testid="controls-empty" class="text-neutral-600">{m.controls_empty()}</p>
{:else}
	{#each data.groups as group (group.id)}
		<section class="mb-10" data-testid="control-group-{group.slug}">
			<h2 class="mb-1 flex items-baseline gap-2 text-xl font-medium">
				{group.name}
				{#if group.isNameFallback}<FallbackNotice locale={group.nameLocale} />{/if}
			</h2>
			{#if group.description}<p class="mb-3 text-neutral-600">{group.description}</p>{/if}

			<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each group.controls as item (item.id)}
					<li class="p-4" data-testid="control-{item.slug}">
						<div class="flex flex-wrap items-baseline gap-3">
							<span class="font-medium">{item.title}</span>
							<Badge tone={TONE[item.status]}>{LABEL[item.status]()}</Badge>
							{#if item.isTranslationFallback}
								<FallbackNotice locale={item.translationLocale} />
							{/if}
						</div>

						{#if item.description}
							<p class="mt-1 text-sm text-neutral-600">{item.description}</p>
						{/if}

						{#if item.evidence.length > 0}
							<p class="mt-2 text-sm">
								<span class="text-neutral-500">{m.controls_evidence()}:</span>
								{#each item.evidence as evidence, index (evidence.id)}
									{#if index > 0}<span>, </span>{/if}
									<a
										href="{localizePath('/documents', data.locale)}#{evidence.slug}"
										class="underline underline-offset-4">{evidence.title}</a
									>
								{/each}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}
{/if}
