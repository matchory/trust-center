<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * `EndpointInvalid.field`, rendered. Both the create form and the edit form
	 * fail the same four ways, so the mapping lives once — a second copy is how
	 * a fifth field comes to be handled on one page and not the other.
	 */
	let { field }: { field: string | null | undefined } = $props();
</script>

{#if field}
	<p data-testid="endpoint-error" class="text-sm text-red-700">
		{field === 'url'
			? m.admin_integrations_error_url()
			: field === 'patterns'
				? m.admin_integrations_error_patterns()
				: field === 'format'
					? m.admin_integrations_error_format()
					: m.admin_integrations_error_name()}
	</p>
{/if}
