<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<!-- `noindex` comes only from this component — the portal layout emits no
     default robots directive — and without it this page would carry none at
     all. It is reachable only with a token, but mail scanners fetch these URLs
     by design (P4.3), and some index what they fetch. -->
<Seo
	baseUrl={data.baseUrl}
	title={m.confirm_title()}
	description={m.confirm_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

{#if form?.confirmed}
	<SectionHeading title={m.confirm_done_title()} />
	<p data-testid="confirm-done" class="max-w-prose text-neutral-700">{m.confirm_done_body()}</p>
{:else}
	<SectionHeading title={m.confirm_title()} description={m.confirm_intro()} />

	{#if form?.expired}
		<p data-testid="confirm-expired" class="mb-4 text-sm text-red-700">{m.confirm_expired()}</p>
	{/if}

	<form method="POST" use:enhance>
		<input type="hidden" name="token" value={data.token} />
		<button data-testid="confirm-submit" class="rounded bg-neutral-900 px-3 py-1.5 text-white"
			>{m.confirm_button()}</button
		>
	</form>
{/if}
