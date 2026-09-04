<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageData } from './$types';

	// Taken from the page's own data rather than imported from
	// `$lib/server/auditsink/status`: nothing under `$lib/server` may be reached
	// from a component, and the load's return type is the same type anyway.
	type Status = PageData['auditSink'];
	type Sink = Status['sinks'][number];
	type Lock = NonNullable<Sink['objectLock']>;

	/**
	 * Read-only by design (spec §10): every fact here is set in the environment
	 * or produced by the job, so a form would only offer to change something
	 * this page cannot change.
	 */
	let { status, locale }: { status: Status; locale: string } = $props();

	// The shared audit formatter, which renders UTC and says so: an operator
	// correlating a stuck sink with server logs must not read a timestamp that
	// silently shifted by their own offset.
	const when = (at: Date) => formatDateTime(at, locale);

	const LOCK_LABEL: Record<Lock, () => string> = {
		compliance: () => m.admin_auditsink_lock_compliance(),
		governance: () => m.admin_auditsink_lock_governance(),
		none: () => m.admin_auditsink_lock_none(),
		unknown: () => m.admin_auditsink_lock_unknown()
	};

	// `none` is the one status that is a finding rather than a fact: the bucket
	// applies no retention, so the guarantee the panel exists to evidence is
	// absent. `unknown` is amber because it is a gap in what we can see, not a
	// known failure.
	const LOCK_TONE: Record<Lock, string> = {
		compliance: 'text-green-700',
		governance: 'text-green-700',
		none: 'text-red-700',
		unknown: 'text-amber-700'
	};

	function errorLine(sink: Sink): string {
		if (!sink.lastError) return m.admin_auditsink_no_error();

		return sink.lastError.statusCode === null
			? m.admin_auditsink_last_error({ reason: sink.lastError.reason })
			: m.admin_auditsink_last_error_status({
					reason: sink.lastError.reason,
					status: sink.lastError.statusCode
				});
	}
</script>

<section class="mt-10" data-testid="auditsink-panel">
	<h2 class="mb-2 text-xl font-semibold">{m.admin_auditsink()}</h2>
	<p class="mb-4 max-w-2xl text-sm text-neutral-600">{m.admin_auditsink_intro()}</p>

	{#if !status.enabled}
		<p
			data-testid="auditsink-off"
			class="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
		>
			{m.admin_auditsink_off()}
		</p>
	{/if}

	<div class="mb-4 grid gap-1 rounded border bg-white p-4 text-sm" data-testid="auditsink-coverage">
		<h3 class="font-medium">{m.admin_auditsink_coverage()}</h3>
		<span class="text-neutral-600">
			{m.admin_auditsink_coverage_events({
				count: status.coverage.eventCount,
				seq: status.coverage.eventMaxSeq
			})}
		</span>
		<span class="text-neutral-600">
			{m.admin_auditsink_coverage_batches({
				count: status.coverage.batchCount,
				seq: status.coverage.batchedMaxSeq
			})}
		</span>
		<span class="text-neutral-600">
			{status.coverage.lastBatchAt
				? m.admin_auditsink_last_batch({ at: when(status.coverage.lastBatchAt) })
				: m.admin_auditsink_no_batches()}
		</span>
		<span class="text-neutral-600" data-testid="auditsink-attested">
			{status.coverage.lastAttestedAt
				? m.admin_auditsink_last_attested({ at: when(status.coverage.lastAttestedAt) })
				: m.admin_auditsink_never_attested()}
		</span>
	</div>

	<ul class="divide-y rounded border bg-white">
		{#each status.sinks as sink (sink.name)}
			<li class="grid gap-1 p-4" data-testid="auditsink-row-{sink.name}">
				<div class="flex flex-wrap items-center gap-3">
					<span class="font-medium">{sink.name}</span>
					{#if !sink.configured}
						<span data-testid="auditsink-unconfigured" class="text-sm text-neutral-500">
							{m.admin_auditsink_not_configured()}
						</span>
					{:else if sink.objectLock}
						<span
							data-testid="auditsink-lock-{sink.name}"
							class="text-sm {LOCK_TONE[sink.objectLock]}"
						>
							{m.admin_auditsink_lock()}: {LOCK_LABEL[sink.objectLock]()}
						</span>
					{/if}
				</div>

				{#if sink.configured}
					<div class="flex flex-wrap gap-4 text-sm text-neutral-500">
						<span data-testid="auditsink-pending-{sink.name}">
							{m.admin_auditsink_pending({ count: sink.pending })}
						</span>
						{#if sink.oldestPendingAt}
							<span>{m.admin_auditsink_oldest({ at: when(sink.oldestPendingAt) })}</span>
						{/if}
						<span>
							{sink.lastShippedAt
								? m.admin_auditsink_last_shipped({ at: when(sink.lastShippedAt) })
								: m.admin_auditsink_never_shipped()}
						</span>
						<span class={sink.lastError ? 'text-red-700' : ''}>{errorLine(sink)}</span>
					</div>

					{#if sink.digestMismatches > 0}
						<p data-testid="auditsink-mismatch-{sink.name}" class="text-sm text-neutral-500">
							{m.admin_auditsink_mismatches({ count: sink.digestMismatches })} —
							{m.admin_auditsink_mismatch_hint()}
						</p>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
</section>
