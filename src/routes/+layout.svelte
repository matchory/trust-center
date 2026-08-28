<script lang="ts">
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Client-side navigation between `/` and `/en` reuses this component tree
	// (reroute makes both resolve to the same route), so nothing reloads and
	// `<html lang>` — the value hooks.client.ts's getLocale() override reads —
	// would otherwise stay frozen at whatever the initial SSR response set.
	// `$effect.pre` runs before the DOM updates for a given reactive flush, so
	// the attribute is updated before the `{#key}` block below remounts the
	// page and re-evaluates its `m.*()` calls.
	$effect.pre(() => {
		document.documentElement.lang = data.locale;
	});
</script>

{#key data.locale}
	{@render children()}
{/key}
