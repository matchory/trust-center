<script lang="ts">
	import { resolve } from '$app/paths';
	import { ADMIN_SECTIONS } from '$lib/admin/sections';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { LayoutServerData } from './$types';

	let { data, children }: { data: LayoutServerData; children: import('svelte').Snippet } = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen bg-neutral-50 text-neutral-900">
	<header class="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
		<a href={resolve('/admin')} class="font-semibold">{m.site_title()} · {m.nav_admin()}</a>

		<div class="flex items-center gap-4 text-sm">
			<span data-testid="staff-email">{data.staff.email}</span>
			<span data-testid="staff-role" class="rounded bg-neutral-100 px-2 py-0.5"
				>{data.staff.role}</span
			>
			<form method="POST" action="/auth/logout">
				<button data-testid="sign-out" type="submit" class="underline">{m.admin_sign_out()}</button>
			</form>
		</div>
	</header>

	<nav class="border-b border-neutral-200 bg-white px-6" aria-label={m.nav_admin()}>
		<ul class="mx-auto flex max-w-5xl gap-4 py-2 text-sm">
			{#each ADMIN_SECTIONS.filter((section) => !section.role || section.role === data.staff.role) as section (section.path)}
				<li class="flex items-center gap-1">
					<a
						href={localizePath(section.path, data.locale)}
						data-testid="admin-nav-{section.path.split('/').pop()}"
						class="hover:underline">{section.label()}</a
					>
					<!-- The audit sink's failure mode is that the compliance record
					     quietly stops leaving the box, and on a deployment with no
					     metrics collector nothing else would say so (spec §9, §10). -->
					{#if section.path === '/admin/settings/integrations' && data.auditSinkBacklog}
						<span
							data-testid="admin-nav-auditsink-backlog"
							title={m.admin_auditsink_backlog()}
							class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900"
						>
							!
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>

	<main class="mx-auto max-w-5xl px-6 py-8">
		{@render children()}
	</main>
</div>
