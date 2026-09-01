<script lang="ts">
	import { onMount } from 'svelte';
	// Type-only, so nothing from `@milkdown/*` reaches the bundle from here —
	// the value imports below are dynamic on purpose (§10.4).
	import type { Editor } from '@milkdown/core';

	let {
		name,
		value = '',
		readonly = false,
		testId
	}: { name: string; value?: string; readonly?: boolean; testId?: string } = $props();

	// The textarea is the form's field and the editor's mirror. Keeping it means
	// `?/saveBody` never learns that the editor exists — the POST shape is the
	// one Phase 3b established, and a body typed into a browser with JavaScript
	// disabled still submits.
	// The prop seeds the editor once; every later change comes through
	// `setMarkdown`, which the page calls when an import returns.
	// svelte-ignore state_referenced_locally
	let markdown = $state(value);
	let host: HTMLDivElement | undefined = $state();
	let editor: Editor | null = null;

	/** Called from the page when an import returns a new body for this locale. */
	export function setMarkdown(next: string): void {
		markdown = next;
		// Replacing the document from outside means tearing the editor down and
		// building it again: ProseMirror owns its DOM and there is no supported
		// way to swap a document under it without losing the selection anyway.
		void remount();
	}

	async function remount(): Promise<void> {
		await editor?.destroy();
		editor = null;
		await mount();
	}

	async function mount(): Promise<void> {
		if (readonly || !host) return;

		// Dynamic, so `@milkdown/*` lands in an admin chunk and no public route
		// ever loads it (§10.4). Static imports here would put it in the shared
		// entry and break that guarantee silently.
		const [{ Editor, rootCtx, defaultValueCtx }, commonmark, { listener, listenerCtx }, { nord }] =
			await Promise.all([
				import('@milkdown/core'),
				import('@milkdown/preset-commonmark'),
				import('@milkdown/plugin-listener'),
				import('@milkdown/theme-nord'),
				// `nord` only sets view options; its stylesheet is a separate entry,
				// and without it Tailwind's reset leaves a heading looking like body
				// text in the one place an author is judging structure.
				import('@milkdown/theme-nord/style.css')
			]);

		const root = host;

		editor = await Editor.make()
			.config(nord)
			.config((ctx) => {
				ctx.set(rootCtx, root);
				ctx.set(defaultValueCtx, markdown);
				ctx.get(listenerCtx).markdownUpdated((_, next) => {
					markdown = next;
				});
			})
			.use(listener)
			.use(subsetOnly(commonmark))
			.create();
	}

	type Preset = typeof import('@milkdown/preset-commonmark');
	/**
	 * What `Editor.use` accepts, read off the method because `@milkdown/ctx` —
	 * where `MilkdownPlugin` lives — is not a direct dependency of this project.
	 */
	type Plugins = Parameters<Editor['use']>[0];

	/**
	 * The nodes §5.1 leaves out of the subset. Matched against the preset's own
	 * export names rather than listed plugin by plugin, because every node ships
	 * a schema, attributes, a keymap, input rules and commands — and dropping a
	 * schema while keeping the input rule that looks its type up throws at
	 * creation, which is a blank editor rather than a message.
	 */
	const EXCLUDED_NODES = ['blockquote', 'image', 'codeblock', 'inlinecode', 'link', 'html'];

	/**
	 * §5.1: the editor must not offer what the server is going to refuse — an
	 * offer accepted and then rejected is a worse failure than one never made.
	 * This is a convenience and never the control; `parseAgreementBody` is, and
	 * the preview beside the editor is what an author actually checks. No GFM
	 * preset is loaded at all, which is what keeps tables out (P3.24).
	 */
	function subsetOnly(preset: Preset): Plugins {
		// Built in one pass rather than filled with `add`, because eslint reads a
		// mutated `Set` as reactive state and asks for `SvelteSet`; this one is a
		// local lookup table that never outlives the call.
		const excluded = new Set<unknown>(
			Object.entries(preset as Record<string, unknown>)
				.filter(([key]) => EXCLUDED_NODES.some((node) => key.toLowerCase().includes(node)))
				.flatMap(([, plugin]) =>
					Array.isArray(plugin) ? (plugin.flat(Infinity) as unknown[]) : [plugin]
				)
		);

		// Cast rather than typed: `commonmark` is declared as a union array that
		// includes `sanitizeLinkHref`, a plain `(href) => string`, so the preset's
		// own type is not assignable to the `use` it exists to be passed to —
		// filter or no filter.
		const plugins = preset.commonmark as unknown as unknown[];
		return plugins.filter((plugin) => !excluded.has(plugin)) as Plugins;
	}

	onMount(() => {
		void mount();
		return () => void editor?.destroy();
	});
</script>

{#if readonly}
	<textarea
		data-testid={testId}
		{name}
		readonly
		rows="8"
		class="w-full rounded border px-2 py-1 font-mono">{markdown}</textarea
	>
{:else}
	<div bind:this={host} data-testid="{testId}-editor" class="rounded border px-2 py-1"></div>
	<!-- Hidden, not absent: this is the field the form posts, and the editor is
	     a view over it. -->
	<textarea data-testid={testId} {name} hidden bind:value={markdown}></textarea>
{/if}
