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
	let field: HTMLTextAreaElement | undefined = $state();
	let editor: Editor | null = null;
	/** Serialises the live ProseMirror document; null until the editor mounts. */
	let readMarkdown: (() => string) | null = null;
	/**
	 * Whether something other than the editor wrote the field last. An `input`
	 * event on a hidden textarea cannot come from a person — Svelte's binding
	 * writes the property without dispatching one — so the only source is script:
	 * a paste of raw Markdown, or a client with the editor disabled. Whoever
	 * wrote last owns the value, because the field is what the form posts and
	 * §5.1 puts the control at the server, not at the editor's schema.
	 */
	let writtenFromOutside = false;

	/** Called from the page when an import returns a new body for this locale. */
	export function setMarkdown(next: string): void {
		markdown = next;
		writtenFromOutside = false;
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
		const [
			{ Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx },
			commonmark,
			{ listener, listenerCtx },
			{ nord }
		] = await Promise.all([
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
					writtenFromOutside = false;
				});
			})
			.use(listener)
			.use(subsetOnly(commonmark))
			.create();

		readMarkdown = () =>
			editor?.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)) ?? markdown;
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

	/**
	 * `markdownUpdated` is debounced — measured empty a whole animation frame
	 * after a keystroke — so a save clicked straight after typing posts the
	 * document as it was before, and the save reports success over a body nobody
	 * wrote. §16 named this as the hazard of putting ProseMirror over a form
	 * field: it does not fail, it loses the last edit quietly.
	 *
	 * Serialising at submit time closes it. The listener is on `document` in the
	 * capture phase because `use:enhance` registers its own submit handler on the
	 * form while this component is still waiting for its dynamic imports — a
	 * listener added to the form later would run after enhance had already read
	 * the field.
	 */
	function syncBeforeSubmit(event: Event): void {
		if (!field || event.target !== field.form || !readMarkdown) return;
		if (writtenFromOutside) return;

		markdown = readMarkdown();
		field.value = markdown;
	}

	onMount(() => {
		void mount();
		document.addEventListener('submit', syncBeforeSubmit, true);

		return () => {
			document.removeEventListener('submit', syncBeforeSubmit, true);
			void editor?.destroy();
		};
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
	<textarea
		bind:this={field}
		data-testid={testId}
		{name}
		hidden
		bind:value={markdown}
		oninput={() => (writtenFromOutside = true)}></textarea>
{/if}
