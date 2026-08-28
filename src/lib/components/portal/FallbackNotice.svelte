<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	let { locale }: { locale: string } = $props();

	let language = $derived(
		new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
	);
</script>

<span
	data-testid="fallback-notice"
	lang={locale}
	class="text-xs text-neutral-500 italic"
	title={m.content_fallback_notice({ language })}
>
	{m.content_fallback_notice({ language })}
</span>
