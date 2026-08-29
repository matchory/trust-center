<script lang="ts">
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<!-- The portal shell is the parent layout's; this adds only the band that says
     who is signed in, so spec §6.2's "same shell" is real rather than nominal. -->
{#if data.requester}
	<div
		data-testid="access-identity"
		class="mb-8 flex flex-wrap items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm"
	>
		<span class="text-neutral-600">
			{m.access_signed_in_as({ email: data.requester.email })}
		</span>

		<form method="POST" action={localizePath('/access/logout', data.locale)} class="ml-auto">
			<button type="submit" data-testid="access-sign-out" class="underline underline-offset-4">
				{m.access_sign_out()}
			</button>
		</form>
	</div>
{/if}

{@render children()}
