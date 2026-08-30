<script lang="ts">
	import ScopeSummary from '$lib/components/admin/ScopeSummary.svelte';
	import { formatDate } from '$lib/format';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STATUS_LABEL: Record<string, () => string> = {
		pending: () => m.admin_request_status_pending(),
		info_requested: () => m.admin_request_status_info_requested(),
		approved: () => m.admin_request_status_approved(),
		denied: () => m.admin_request_status_denied()
	};

	const TIER_LABEL: Record<string, () => string> = {
		request: () => m.request_tier_request(),
		nda: () => m.request_tier_nda()
	};

	// A decided request is read-only: `decideRequest` refuses a second decision,
	// so offering the form would only produce a 409.
	let decided = $derived(data.request.status === 'approved' || data.request.status === 'denied');
</script>

<div class="mb-6">
	<a
		href={localizePath('/admin/requests', data.locale)}
		class="text-sm underline underline-offset-4">{m.nav_requests()}</a
	>
	<h1 class="mt-1 text-2xl font-semibold">{data.request.email}</h1>
	<p class="mt-1 text-sm text-neutral-600">
		{data.request.name} · {data.request.company} ·
		{m.admin_requested_at()}
		{formatDate(data.request.createdAt, data.locale)}
	</p>
</div>

<dl class="mb-8 grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
	<dt class="text-neutral-500">{m.admin_status()}</dt>
	<dd data-testid="request-detail-status">
		{STATUS_LABEL[data.request.status]?.() ?? data.request.status}
	</dd>

	<dt class="text-neutral-500">{m.admin_scope()}</dt>
	<dd>
		<ScopeSummary tiers={data.request.requestedTiers} documentCount={data.request.documentCount} />
	</dd>

	{#if data.request.justification}
		<dt class="text-neutral-500">{m.admin_justification()}</dt>
		<dd class="whitespace-pre-line">{data.request.justification}</dd>
	{/if}

	{#if data.request.reason}
		<dt class="text-neutral-500">{m.admin_decision_reason()}</dt>
		<dd>{data.request.reason}</dd>
	{/if}

	{#if data.request.decidedAt}
		<dt class="text-neutral-500">{m.admin_decided_at()}</dt>
		<dd>{formatDate(data.request.decidedAt, data.locale)}</dd>
	{/if}
</dl>

{#if form?.failed}
	<p data-testid="decision-error" class="mb-4 max-w-prose text-sm text-red-700">
		{m.admin_decision_error()}
	</p>
{/if}

{#if !decided}
	<form method="POST" class="max-w-2xl space-y-5 rounded border bg-white p-5">
		<fieldset>
			<legend class="mb-2 text-sm font-medium">{m.admin_scope()}</legend>

			{#each data.tiers as tier (tier)}
				<label class="mb-2 flex items-center gap-2">
					<input
						type="checkbox"
						name="tiers"
						value={tier}
						data-testid="decision-tier-{tier}"
						checked={data.request.requestedTiers.includes(tier)}
					/>
					<span>{TIER_LABEL[tier]?.() ?? tier}</span>
				</label>
			{/each}

			{#each data.documents as doc (doc.id)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						name="documentIds"
						value={doc.id}
						data-testid="decision-document-{doc.slug}"
						checked={data.request.requestedDocumentIds.includes(doc.id)}
					/>
					<span>{doc.title}</span>
				</label>
			{/each}
		</fieldset>

		<fieldset>
			<legend class="mb-2 text-sm font-medium">{m.admin_decision_groups()}</legend>

			{#if data.groups.length === 0}
				<p class="text-sm text-neutral-500">{m.admin_no_entries()}</p>
			{/if}

			<!-- Not pre-checked from the request: nobody asked for a group. They are
			     the approver's own instrument, and §4.2 keeps them off the public
			     form entirely. -->
			{#each data.groups as group (group.id)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						name="groupIds"
						value={group.id}
						data-testid="decision-group-{group.slug}"
					/>
					<span>{group.names[data.locale] ?? group.slug}</span>
				</label>
			{/each}
		</fieldset>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_decision_term_days()}</span>
			<input
				type="number"
				min="1"
				max="3650"
				name="termDays"
				value={data.defaultTermDays}
				data-testid="decision-term-days"
				class="rounded border px-2 py-1"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_decision_reason()}</span>
			<textarea name="reason" rows="2" class="w-full rounded border px-3 py-2"></textarea>
		</label>

		<div class="flex flex-wrap gap-3">
			<button
				formaction="?/approve"
				data-testid="decision-approve"
				class="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
				>{m.admin_decision_approve()}</button
			>
			<button
				formaction="?/deny"
				data-testid="decision-deny"
				class="rounded border px-4 py-2 text-sm">{m.admin_decision_deny()}</button
			>
			<button
				formaction="?/requestInfo"
				data-testid="decision-request-info"
				class="rounded border px-4 py-2 text-sm">{m.admin_decision_request_info()}</button
			>
		</div>
	</form>
{/if}
