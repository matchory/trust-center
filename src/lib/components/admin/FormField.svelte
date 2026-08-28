<script lang="ts">
	let {
		label,
		error = null,
		children
	}: {
		label: string;
		error?: string | null;
		children: import('svelte').Snippet;
	} = $props();
</script>

<label class="grid gap-1 text-sm">
	<span>{label}</span>
	{@render children()}
	{#if error}<span class="text-sm text-red-700">{error}</span>{/if}
</label>
