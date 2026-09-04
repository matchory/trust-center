<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import EgressOffNotice from '../EgressOffNotice.svelte';
	import EndpointFormError from '../EndpointFormError.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-2 text-2xl font-semibold">{data.endpoint.name}</h1>
<p class="mb-6 font-mono text-sm text-neutral-500">
	{m.admin_integrations_secret_version({ version: data.endpoint.secretVersion })}
</p>

<EgressOffNotice enabled={data.egressEnabled} />

<!-- The operator chooses what their channel contains; they are told what they
     are choosing (spec §9.1). -->
{#each data.highFrequency as entry (entry.pattern)}
	<p
		data-testid="endpoint-high-frequency"
		class="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
	>
		{m.admin_integrations_high_frequency({
			pattern: entry.pattern,
			count: entry.weekly,
			threshold: data.threshold
		})}
	</p>
{/each}

<form
	method="POST"
	action="?/save"
	use:enhance
	class="mb-8 grid max-w-2xl gap-3 rounded border bg-white p-4"
>
	<FormField label={m.admin_integrations_name()}>
		<input
			data-testid="endpoint-name"
			name="name"
			value={data.endpoint.name}
			required
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<!-- The full URL appears here and on no other page: this is the form that
	     edits it (spec §11). -->
	<FormField label={m.admin_integrations_url()}>
		<input
			data-testid="endpoint-url"
			name="url"
			type="url"
			value={data.endpoint.url}
			required
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_integrations_format()}>
		<select data-testid="endpoint-format" name="format" class="rounded border px-2 py-1">
			{#each data.formats as format (format)}
				<option value={format} selected={format === data.endpoint.format}>{format}</option>
			{/each}
		</select>
	</FormField>

	<FormField label={m.admin_integrations_patterns()}>
		<textarea
			data-testid="endpoint-patterns"
			name="patterns"
			rows="4"
			required
			class="rounded border px-2 py-1 font-mono text-sm"
			>{data.endpoint.patterns.join('\n')}</textarea
		>
		<span class="text-xs text-neutral-500">{m.admin_integrations_patterns_hint()}</span>
	</FormField>

	<EndpointFormError field={form?.field} />

	{#if form?.saved}
		<p data-testid="endpoint-saved" class="text-sm text-green-700">{m.admin_saved()}</p>
	{/if}

	<button
		data-testid="endpoint-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_save()}
	</button>
</form>

<div class="mb-8 grid max-w-2xl gap-3 rounded border bg-white p-4">
	{#if data.endpoint.enabled}
		<form method="POST" action="?/disable" use:enhance class="grid gap-2">
			<FormField label={m.admin_integrations_disable_reason()}>
				<input
					data-testid="endpoint-disable-reason"
					name="reason"
					class="rounded border px-2 py-1"
				/>
			</FormField>
			<button data-testid="endpoint-disable" class="justify-self-start rounded border px-3 py-1.5">
				{m.admin_integrations_disable()}
			</button>
		</form>
	{:else}
		{#if data.endpoint.disabledReason}
			<p data-testid="endpoint-disabled-reason" class="text-sm text-red-700">
				{data.endpoint.disabledReason}
			</p>
		{/if}

		<!-- Skip first, with the pending count beside it: a channel flooded with
		     a day of stale notices is worse than a gap (spec §5.5). -->
		<form method="POST" action="?/enable" use:enhance class="flex flex-wrap gap-3">
			<input type="hidden" name="skipBacklog" value="true" />
			<button
				data-testid="endpoint-enable-skip"
				class="rounded bg-neutral-900 px-3 py-1.5 text-white"
			>
				{m.admin_integrations_enable_skip({ count: data.endpoint.pendingDepth })}
			</button>
		</form>
		<form method="POST" action="?/enable" use:enhance>
			<button data-testid="endpoint-enable-catch-up" class="rounded border px-3 py-1.5">
				{m.admin_integrations_enable_catch_up()}
			</button>
		</form>
	{/if}
</div>

<div class="mb-8 grid max-w-2xl gap-3 rounded border bg-white p-4">
	<div class="flex flex-wrap gap-3">
		<form method="POST" action="?/rotate" use:enhance>
			<button data-testid="endpoint-rotate" class="rounded border px-3 py-1.5">
				{m.admin_integrations_rotate()}
			</button>
		</form>
		<form method="POST" action="?/reveal" use:enhance>
			<button data-testid="endpoint-reveal" class="rounded border px-3 py-1.5">
				{m.admin_integrations_reveal()}
			</button>
		</form>
		<form method="POST" action="?/test" use:enhance>
			<button data-testid="endpoint-test" class="rounded border px-3 py-1.5">
				{m.admin_integrations_test()}
			</button>
		</form>
	</div>

	{#if form?.secretVersion}
		<p data-testid="endpoint-secret-version" class="text-sm text-green-700">
			{m.admin_integrations_secret_version({ version: form.secretVersion })}
		</p>
	{/if}

	{#if form?.secret}
		<!-- Revealed by an action, never carried in the page's load payload. -->
		<p data-testid="endpoint-secret" class="font-mono text-xs break-all">{form.secret}</p>
	{:else if !data.signingKeyConfigured}
		<p class="text-sm text-neutral-500">{m.admin_integrations_secret_missing()}</p>
	{/if}

	{#if form?.test}
		<p
			data-testid="endpoint-test-result"
			class="text-sm {form.test.reason === null ? 'text-green-700' : 'text-red-700'}"
		>
			{form.test.reason === null
				? m.admin_integrations_test_ok({ status: form.test.statusCode ?? 0 })
				: m.admin_integrations_test_failed({ reason: form.test.reason })}
		</p>
	{/if}
</div>

<form method="POST" action="?/delete" use:enhance>
	<button
		data-testid="endpoint-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-red-700"
	>
		{m.admin_integrations_delete()}
	</button>
</form>
