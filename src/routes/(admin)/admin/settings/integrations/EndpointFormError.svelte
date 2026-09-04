<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * `EndpointInvalid.field`, rendered. Both the create form and the edit form
	 * fail the same four ways, so the mapping lives once — a second copy is how
	 * a fifth field comes to be handled on one page and not the other.
	 */
	let { field }: { field: string | null | undefined } = $props();

	/**
	 * Keyed rather than a ternary chain whose last branch is unconditional: that
	 * shape renders "a name is required" for any field it does not name, so a
	 * fifth `EndpointInvalid.field` would report the wrong input rather than
	 * nothing.
	 */
	const MESSAGES: Record<string, () => string> = {
		name: m.admin_integrations_error_name,
		url: m.admin_integrations_error_url,
		patterns: m.admin_integrations_error_patterns,
		format: m.admin_integrations_error_format
	};

	const message = $derived(field ? (MESSAGES[field] ?? null) : null);
</script>

{#if message}
	<p data-testid="endpoint-error" class="text-sm text-red-700">{message()}</p>
{/if}
