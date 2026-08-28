<script lang="ts">
	import { page } from '$app/state';
	import { COMPILED_LOCALES } from '$lib/i18n/compiled';
	import { localizePath, stripLocale } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';

	let { locales, current }: { locales: readonly string[]; current: string } = $props();

	// The locale-free path, so switching language keeps the visitor on the page
	// they were reading rather than sending them back to the root.
	let basePath = $derived(stripLocale(page.url.pathname, COMPILED_LOCALES).path);

	// Intl.DisplayNames rather than a hand-maintained map: it names any locale
	// the deployment compiles, in that locale's own language, and it is built
	// into the platform — the portal loads nothing third-party.
	function endonym(locale: string): string {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
	}
</script>

<nav aria-label={m.portal_language()} class="flex items-center gap-3 text-sm">
	{#each locales as locale (locale)}
		{#if locale === current}
			<span data-testid="locale-switch-{locale}" aria-current="true" class="font-semibold"
				>{endonym(locale)}</span
			>
		{:else}
			<a
				data-testid="locale-switch-{locale}"
				href={localizePath(basePath, locale)}
				hreflang={locale}
				class="underline underline-offset-4 hover:no-underline">{endonym(locale)}</a
			>
		{/if}
	{/each}
</nav>
