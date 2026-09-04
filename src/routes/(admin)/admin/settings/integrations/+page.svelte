<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import EgressOffNotice from './EgressOffNotice.svelte';
	import EndpointFormError from './EndpointFormError.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-2 text-2xl font-semibold">{m.admin_integrations()}</h1>
<p class="mb-6 max-w-2xl text-sm text-neutral-600">{m.admin_integrations_intro()}</p>

<EgressOffNotice enabled={data.egressEnabled} />

<form
	method="POST"
	action="?/create"
	use:enhance
	class="mb-8 grid max-w-2xl gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_integrations_name()}>
		<input data-testid="endpoint-name" name="name" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_integrations_url()}>
		<input
			data-testid="endpoint-url"
			name="url"
			type="url"
			required
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_integrations_format()}>
		<select data-testid="endpoint-format" name="format" class="rounded border px-2 py-1">
			{#each data.formats as format (format)}
				<option value={format}>{format}</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_integrations_patterns()}>
		<textarea
			data-testid="endpoint-patterns"
			name="patterns"
			rows="3"
			required
			class="rounded border px-2 py-1 font-mono text-sm"></textarea>
		<span class="text-xs text-neutral-500">{m.admin_integrations_patterns_hint()}</span>
	</FormField>

	<EndpointFormError field={form?.field} />

	<button
		data-testid="endpoint-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_integrations_new()}
	</button>
</form>

<ul class="divide-y rounded border bg-white">
	{#each data.endpoints as endpoint (endpoint.id)}
		<li class="grid gap-1 p-4" data-testid="endpoint-row-{endpoint.id}">
			<div class="flex flex-wrap items-center gap-3">
				<a
					href={localizePath(`/admin/settings/integrations/${endpoint.id}`, data.locale)}
					class="font-medium underline"
				>
					{endpoint.name}
				</a>
				<span class="rounded bg-neutral-100 px-2 py-0.5 text-xs">{endpoint.format}</span>
				<!-- The host and nothing else: a Teams Workflows URL carries its
				     shared secret in the query string (spec §11). -->
				<span data-testid="endpoint-host" class="font-mono text-sm text-neutral-500"
					>{endpoint.host}</span
				>
				<span
					data-testid="endpoint-status"
					class="text-sm {endpoint.enabled ? 'text-green-700' : 'text-red-700'}"
				>
					{endpoint.enabled
						? m.admin_integrations_status_enabled()
						: m.admin_integrations_status_disabled()}
				</span>
			</div>

			<div class="flex flex-wrap gap-4 text-sm text-neutral-500">
				<span data-testid="endpoint-pending"
					>{m.admin_integrations_pending({ count: endpoint.pendingDepth })}</span
				>
				<span>
					{m.admin_integrations_last_outcome()}:
					{#if endpoint.lastOutcome}
						{endpoint.lastOutcome.status}{endpoint.lastOutcome.statusCode !== null
							? ` (${endpoint.lastOutcome.statusCode})`
							: ''}
					{:else}
						{m.admin_integrations_never()}
					{/if}
				</span>
				<span class="font-mono">{endpoint.patterns.join(', ')}</span>
			</div>

			{#if !endpoint.enabled && endpoint.disabledReason}
				<p data-testid="endpoint-disabled-reason" class="text-sm text-red-700">
					{endpoint.disabledReason}
				</p>
			{/if}
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
