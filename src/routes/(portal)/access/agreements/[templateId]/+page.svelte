<script lang="ts">
	import { enhance } from '$app/forms';
	import AgreementBody from '$lib/components/AgreementBody.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<Seo
	baseUrl={data.baseUrl}
	title={data.name}
	description={m.agreements_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

<SectionHeading title={data.name} />

{#if !data.agreement}
	<p data-testid="agreement-unavailable" class="max-w-prose text-neutral-700">
		{m.agreement_unavailable()}
	</p>
{:else}
	<!-- The same renderer the admin preview uses. A second implementation is how
	     the thing an operator approved and the thing a requester signs come to
	     differ. -->
	<article data-testid="agreement-body" class="max-w-prose rounded-lg border bg-white p-6">
		<AgreementBody root={data.agreement.root} />
	</article>

	<form method="POST" use:enhance class="mt-6 max-w-prose space-y-4">
		<!-- What was rendered, carried back so the record pins the bytes this
		     person actually saw rather than whatever is current at POST time. -->
		<input type="hidden" name="versionId" value={data.agreement.versionId} />
		<input type="hidden" name="sha256" value={data.agreement.sha256} />

		<!-- §10.2: versioned with the application, above the button and outside
		     the body. An operator authoring their own agreement will not include
		     it and nothing would check, so putting it in the template body would
		     evaporate the guarantee for every deployment but ours. -->
		<p data-testid="agreement-erasure-notice" class="text-sm text-neutral-600">
			{m.agreement_erasure_notice()}
		</p>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.agreement_typed_name()}</span>
			<input
				name="typedName"
				required
				autocomplete="name"
				data-testid="agreement-typed-name"
				class="w-full rounded border px-3 py-2"
			/>
		</label>

		{#if form?.moved}
			<p data-testid="agreement-moved" class="text-sm text-red-700">{m.agreement_moved()}</p>
		{:else if form?.nameRequired}
			<p data-testid="agreement-name-required" class="text-sm text-red-700">
				{m.agreement_typed_name_required()}
			</p>
		{:else if form?.failed}
			<p data-testid="agreement-error" class="text-sm text-red-700">{m.agreement_unavailable()}</p>
		{/if}

		<button
			data-testid="agreement-accept"
			class="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
		>
			{m.agreement_accept()}
		</button>
	</form>
{/if}
