<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<h1 class="text-2xl font-semibold">{data.staff.name}</h1>
<p class="mt-2 text-neutral-600">{m.admin_dashboard_intro()}</p>
