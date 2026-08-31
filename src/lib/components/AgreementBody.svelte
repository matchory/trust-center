<!-- src/lib/components/AgreementBody.svelte -->
<script lang="ts">
	import type { Root, RootContent } from 'mdast';

	// The click-through and the preview are the same renderer pointed at
	// different rows. A second implementation is how the thing an operator
	// approved and the thing a requester signs come to differ.
	//
	// This emits only nodes the subset admits, so there is no HTML
	// sanitisation step: there is no untrusted HTML to sanitise.
	let { root }: { root: Root } = $props();

	function children(node: RootContent): RootContent[] {
		return 'children' in node ? (node.children as RootContent[]) : [];
	}
</script>

{#snippet inline(nodes: RootContent[])}
	{#each nodes as node (node)}
		{#if node.type === 'text'}{node.value}
		{:else if node.type === 'strong'}<strong>{@render inline(children(node))}</strong>
		{:else if node.type === 'emphasis'}<em>{@render inline(children(node))}</em>
		{:else if node.type === 'break'}<br />
		{/if}
	{/each}
{/snippet}

{#snippet blocks(nodes: RootContent[])}
	{#each nodes as node (node)}
		{#if node.type === 'heading'}
			<svelte:element this={`h${Math.min(node.depth + 1, 6)}`} class="mt-6 font-semibold">
				{@render inline(children(node))}
			</svelte:element>
		{:else if node.type === 'paragraph'}
			<p class="mt-3 leading-relaxed">{@render inline(children(node))}</p>
		{:else if node.type === 'list'}
			{#if node.ordered}
				<ol
					class="mt-3 list-decimal space-y-1 pl-6"
					start={node.start && node.start !== 1 ? node.start : undefined}
				>
					{@render blocks(children(node))}
				</ol>
			{:else}
				<ul class="mt-3 list-disc space-y-1 pl-6">{@render blocks(children(node))}</ul>
			{/if}
		{:else if node.type === 'listItem'}
			<li>{@render blocks(children(node))}</li>
		{:else if node.type === 'thematicBreak'}
			<hr class="my-6" />
		{/if}
	{/each}
{/snippet}

<div data-testid="agreement-body">{@render blocks(root.children)}</div>
