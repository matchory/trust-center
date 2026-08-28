<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
</script>

<h1 data-testid="site-title">{m.site_title()}</h1>
<p data-testid="admin-link-label">{m.nav_admin()}</p>
<a href={resolve('/auth/login')} data-testid="sign-in">{m.admin_sign_in()}</a>
