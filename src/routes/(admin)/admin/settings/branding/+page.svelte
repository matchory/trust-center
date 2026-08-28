<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_branding()}</h1>

<form
	method="POST"
	enctype="multipart/form-data"
	use:enhance
	class="grid max-w-lg gap-4 rounded border bg-white p-4"
>
	<FormField label={m.admin_organization_name()}>
		<input
			data-testid="branding-organization-name"
			name="organizationName"
			value={data.branding.organizationName}
			required
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_color_primary()}>
		<input
			type="color"
			data-testid="branding-primary-color"
			name="primaryColor"
			value={data.branding.primaryColor}
			class="h-9 w-16 rounded border"
		/>
	</FormField>

	<FormField label={m.admin_color_surface()}>
		<input
			type="color"
			name="surfaceColor"
			value={data.branding.surfaceColor}
			class="h-9 w-16 rounded border"
		/>
	</FormField>

	<FormField label={m.admin_color_ink()}>
		<input
			type="color"
			name="inkColor"
			value={data.branding.inkColor}
			class="h-9 w-16 rounded border"
		/>
	</FormField>

	<FormField label={m.admin_logo()}>
		<input
			type="file"
			data-testid="branding-logo"
			name="logo"
			accept="image/png,image/svg+xml,image/webp"
		/>
	</FormField>

	<FormField label={m.portal_imprint()}>
		<input
			type="url"
			name="imprintUrl"
			value={data.branding.imprintUrl ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.portal_privacy()}>
		<input
			type="url"
			name="privacyUrl"
			value={data.branding.privacyUrl ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	<FormField label={m.admin_contact_email()}>
		<input
			type="email"
			name="contactEmail"
			value={data.branding.contactEmail ?? ''}
			class="rounded border px-2 py-1"
		/>
	</FormField>

	{#if form?.message}
		<p data-testid="branding-error" class="text-sm text-red-700">{form.message}</p>
	{/if}

	<button
		data-testid="branding-save"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
		>{m.admin_save()}</button
	>
</form>
