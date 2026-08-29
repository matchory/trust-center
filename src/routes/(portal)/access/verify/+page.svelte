<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.access_verify_title()}
	description={m.access_verify_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

<SectionHeading title={m.access_verify_title()} description={m.access_verify_intro()} />

{#if form?.failed}
	<p data-testid="verify-failed" class="max-w-prose text-red-700">{m.access_verify_failed()}</p>
{:else}
	<!-- POST, not GET: a link scanner following the URL must not be able to
	     consume the token before the person reading the mail does. -->
	<form method="POST">
		<input type="hidden" name="token" value={data.token} />
		<button
			type="submit"
			data-testid="verify-confirm"
			class="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700"
		>
			{m.access_verify_confirm()}
		</button>
	</form>
{/if}
