<script lang="ts">
	type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

	let { tone = 'neutral', children }: { tone?: Tone; children: import('svelte').Snippet } =
		$props();

	const classes: Record<Tone, string> = {
		ok: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
		warn: 'bg-amber-50 text-amber-900 ring-amber-200',
		danger: 'bg-red-50 text-red-900 ring-red-200',
		neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200'
	};
</script>

<span
	class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset {classes[
		tone
	]}"
>
	{@render children()}
</span>
