<script lang="ts">
	let {
		locales,
		initial,
		translated,
		children
	}: {
		locales: readonly string[];
		/**
		 * Which tab opens. Read once, on purpose — see `active` below. Callers pass
		 * their loaded locale and never hold the selection themselves.
		 */
		initial: string;
		/** Whether a locale has a translation — drives the visible
		 * "not translated" marker the spec's fallback rule requires. */
		translated: (locale: string) => boolean;
		children: import('svelte').Snippet<[string]>;
	} = $props();

	// svelte-ignore state_referenced_locally
	// Seeded once, deliberately not tracking `initial`: the tab a person has
	// clicked must survive a form action's `data` invalidation, which is exactly
	// what this warning describes and exactly what is wanted. Owning the
	// selection here rather than at six call sites means one suppression instead
	// of six, and `pnpm check` stays silent enough to be worth reading.
	let active = $state(initial);
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
