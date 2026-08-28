<script lang="ts">
	import LocaleSwitcher from '$lib/components/portal/LocaleSwitcher.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { PORTAL_SECTIONS } from '$lib/portal/sections';
	import { m } from '$lib/paraglide/messages.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="stylesheet" href="/branding.css" />
	{#if data.branding.logoStorageKey}
		<link rel="icon" href="/api/branding/logo" />
	{/if}
</svelte:head>

<a
	data-testid="skip-to-content"
	href="#content"
	class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
>
	{m.portal_skip_to_content()}
</a>

<div class="min-h-screen bg-[var(--tc-surface,#fafafa)] text-[var(--tc-ink,#171717)]">
	<header class="border-b border-neutral-200 bg-white">
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
			<a
				href={localizePath('/', data.locale)}
				class="flex items-center gap-2 text-lg font-semibold tracking-tight"
			>
				{#if data.branding.logoStorageKey}
					<img src="/api/branding/logo" alt={data.branding.organizationName} class="h-8 w-auto" />
				{:else}
					{data.branding.organizationName}
				{/if}
			</a>

			<nav
				class="flex flex-wrap items-center gap-4 text-sm"
				aria-label={data.branding.organizationName}
			>
				{#each PORTAL_SECTIONS as section (section.path)}
					<a
						href={localizePath(section.path, data.locale)}
						data-testid="nav-{section.path.slice(1)}"
						class="hover:underline hover:underline-offset-4">{section.label()}</a
					>
				{/each}
			</nav>

			<div class="ml-auto">
				<LocaleSwitcher locales={data.locales} current={data.locale} />
			</div>
		</div>
	</header>

	<main id="content" class="mx-auto max-w-5xl px-6 py-12">
		{@render children()}
	</main>

	<footer
		data-testid="portal-footer"
		class="mt-16 border-t border-neutral-200 bg-white px-6 py-8 text-sm text-neutral-500"
	>
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-4">
			<span>{data.branding.organizationName}</span>
			{#if data.branding.imprintUrl}
				<a href={data.branding.imprintUrl} rel="noreferrer noopener external" class="underline"
					>{m.portal_imprint()}</a
				>
			{/if}
			{#if data.branding.privacyUrl}
				<a href={data.branding.privacyUrl} rel="noreferrer noopener external" class="underline"
					>{m.portal_privacy()}</a
				>
			{/if}
			<a data-testid="admin-link-label" href={localizePath('/admin', data.locale)}>
				{m.nav_admin()}
			</a>
			<a data-testid="sign-in" href="/auth/login" class="underline">{m.admin_sign_in()}</a>
		</div>
	</footer>
</div>
