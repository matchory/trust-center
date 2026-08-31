<script lang="ts">
	import { enhance } from '$app/forms';
	import ScopeSummary from '$lib/components/admin/ScopeSummary.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STATE_LABEL: Record<string, () => string> = {
		active: () => m.admin_grant_state_active(),
		expired: () => m.admin_grant_state_expired(),
		revoked: () => m.admin_grant_state_revoked(),
		pending_acceptance: () => m.admin_grant_state_pending_acceptance(),
		unaccepted: () => m.admin_grant_state_unaccepted()
	};
</script>

<div class="mb-6">
	<a
		href={localizePath('/admin/requesters', data.locale)}
		class="text-sm underline underline-offset-4">{m.nav_requesters()}</a
	>
	<h1 class="mt-1 text-2xl font-semibold">{data.requester.email}</h1>
	<p class="mt-1 text-sm text-neutral-600">
		{data.requester.name} · {data.requester.company} ·
		{m.admin_first_seen_at()}
		{formatDate(data.requester.firstSeenAt, data.locale)}
	</p>
</div>

<dl class="mb-8 grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
	<dt class="text-neutral-500">{m.admin_status()}</dt>
	<dd data-testid="requester-detail-state">
		{data.requester.purgedAt ? m.admin_requester_purged() : m.admin_requester_active()}
	</dd>
</dl>

<h2 class="mb-2 text-lg font-semibold">{m.nav_requests()}</h2>
<ul class="mb-8 grid gap-1 text-sm" data-testid="requester-requests">
	{#each data.requester.requests as request (request.id)}
		<li>
			<a
				href={localizePath(`/admin/requests/${request.id}`, data.locale)}
				class="underline underline-offset-4">{formatDate(request.createdAt, data.locale)}</a
			>
			· {request.status}
			· <ScopeSummary tiers={request.tiers} documentCount={request.documentCount} />
		</li>
	{:else}
		<li class="text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>

<h2 class="mb-2 text-lg font-semibold">{m.nav_grants()}</h2>
<ul class="mb-8 grid gap-1 text-sm" data-testid="requester-grants">
	{#each data.requester.grants as grant (grant.id)}
		<li>
			{formatDate(grant.grantedAt, data.locale)} → {grant.expiresAt
				? formatDate(grant.expiresAt, data.locale)
				: '—'}
			· <ScopeSummary
				tiers={grant.tiers}
				groupIds={grant.groupIds}
				documentCount={grant.documentCount}
				groupNames={data.groupNames}
			/>
			{#if grant.state !== 'active'}· {STATE_LABEL[grant.state]?.() ?? grant.state}{/if}
		</li>
	{:else}
		<li class="text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>

<h2 class="mb-2 text-lg font-semibold">{m.admin_audit_log()}</h2>
<ul class="mb-10 grid gap-1 font-mono text-xs" data-testid="requester-events">
	{#each data.events as event (event.id)}
		<li>{formatDate(event.at, data.locale)} · {event.action}</li>
	{:else}
		<li class="font-sans text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>

{#if form?.failed}
	<p data-testid="purge-error" class="mb-4 max-w-prose text-sm text-red-700">
		{m.admin_purge_already()}
	</p>
{/if}

{#if !data.requester.purgedAt}
	<form method="POST" action="?/purge" use:enhance class="max-w-prose rounded border bg-white p-5">
		<h2 class="text-lg font-semibold">{m.admin_purge()}</h2>
		<p class="mt-1 mb-4 text-sm text-neutral-600">{m.admin_purge_intro()}</p>
		<button
			data-testid="requester-purge"
			class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
			onclick={(event) => {
				if (!confirm(m.admin_purge_confirm())) event.preventDefault();
			}}
		>
			{m.admin_purge()}
		</button>
	</form>
{/if}
