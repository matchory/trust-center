<script lang="ts">
	let {
		locales,
		active = $bindable(),
		translated,
		children
	}: {
		locales: readonly string[];
		active: string;
		/** Whether a locale has a translation — drives the visible
		 * "not translated" marker the spec's fallback rule requires. */
		translated: (locale: string) => boolean;
		children: import('svelte').Snippet<[string]>;
	} = $props();
</script>

<div class="mb-3 flex gap-2 border-b">
	{#each locales as locale (locale)}
		<button
			type="button"
			data-testid="locale-tab-{locale}"
			onclick={() => (active = locale)}
			class="border-b-2 px-3 py-2 text-sm {active === locale
				? 'border-neutral-900 font-medium'
				: 'border-transparent text-neutral-500'}"
		>
			{locale}
			{#if !translated(locale)}<span class="ml-1 text-xs text-amber-700">•</span>{/if}
		</button>
	{/each}
</div>

{#each locales as locale (locale)}
	{#if locale === active}{@render children(locale)}{/if}
{/each}
