<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * Why nothing is being delivered. A configured endpoint that delivers
	 * nothing otherwise looks like a bug, and both integrations pages have to
	 * say so — one component so the two cannot come to say it differently.
	 */
	let { enabled }: { enabled: boolean } = $props();
</script>

{#if !enabled}
	<p
		data-testid="integrations-egress-off"
		class="mb-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
	>
		{m.admin_integrations_egress_off()}
	</p>
{/if}
