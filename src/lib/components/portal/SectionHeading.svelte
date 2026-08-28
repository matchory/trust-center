<script lang="ts">
	let { title, description = null }: { title: string; description?: string | null } = $props();
</script>

<header class="mb-8">
	<h1 class="text-3xl font-semibold tracking-tight text-[var(--tc-ink,#171717)]">{title}</h1>
	{#if description}
		<p class="mt-2 max-w-2xl text-neutral-600">{description}</p>
	{/if}
</header>
