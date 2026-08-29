<script lang="ts">
	import { page } from '$app/state';
	import { COMPILED_LOCALES } from '$lib/i18n/compiled';
	import { localizePath, stripLocale } from '$lib/i18n/locale';

	let {
		baseUrl,
		title,
		description,
		siteName,
		locale,
		locales,
		defaultLocale
	}: {
		baseUrl: string;
		title: string;
		description: string;
		siteName: string;
		locale: string;
		locales: readonly string[];
		defaultLocale: string;
	} = $props();

	// Absolute URLs: canonical and og:url must not be relative, and the origin
	// a crawler sees has to be the configured one rather than whatever host
	// header reached the app. `page.url.origin` is the latter — behind a TLS-
	// terminating proxy adapter-node reports the wrong scheme — and it would
	// also disagree with sitemap.xml and robots.txt, which are built from
	// BASE_URL. Two origins is one too many for a crawler.
	let basePath = $derived(stripLocale(page.url.pathname, COMPILED_LOCALES).path);
	let canonical = $derived(`${baseUrl}${localizePath(basePath, locale)}`);
</script>

<svelte:head>
	<title>{title} · {siteName}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />

	{#each locales as alternate (alternate)}
		<link
			rel="alternate"
			hreflang={alternate}
			href="{baseUrl}{localizePath(basePath, alternate)}"
		/>
	{/each}
	<link
		rel="alternate"
		hreflang="x-default"
		href="{baseUrl}{localizePath(basePath, defaultLocale)}"
	/>

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta property="og:locale" content={locale} />
	{#each locales.filter((item) => item !== locale) as alternate (alternate)}
		<meta property="og:locale:alternate" content={alternate} />
	{/each}
	<meta name="twitter:card" content="summary" />
</svelte:head>
