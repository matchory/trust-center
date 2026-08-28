<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { LayoutServerData } from './$types';

	let { data, children }: { data: LayoutServerData; children: import('svelte').Snippet } =
		$props();
</script>

<div class="min-h-screen bg-neutral-50 text-neutral-900">
	<header class="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
		<a href={resolve('/admin')} class="font-semibold">{m.site_title()} · {m.nav_admin()}</a>

		<div class="flex items-center gap-4 text-sm">
			<span data-testid="staff-email">{data.staff.email}</span>
			<span data-testid="staff-role" class="rounded bg-neutral-100 px-2 py-0.5">{data.staff.role}</span>
			<form method="POST" action="/auth/logout">
				<button data-testid="sign-out" type="submit" class="underline">{m.admin_sign_out()}</button>
			</form>
		</div>
	</header>

	<main class="mx-auto max-w-5xl px-6 py-8">
		{@render children()}
	</main>
</div>
