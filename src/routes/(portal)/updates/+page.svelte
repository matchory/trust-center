<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import type { UpdateKind } from '$lib/content-types';
	import { formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const KIND_LABEL: Record<UpdateKind, () => string> = {
		document: () => m.update_kind_document(),
		subprocessor: () => m.update_kind_subprocessor(),
		certification: () => m.update_kind_certification(),
		advisory: () => m.update_kind_advisory()
	};
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.nav_updates()}
	description={m.updates_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
/>

<SectionHeading title={m.nav_updates()} description={m.updates_intro()} />

{#if data.posts.length === 0}
	<p data-testid="updates-empty" class="text-neutral-600">{m.updates_empty()}</p>
{:else}
	<ol class="grid gap-4">
		{#each data.posts as post (post.id)}
			<li>
				<article
					data-testid="update-{post.slug}"
					id={post.slug}
					class="rounded-lg border border-neutral-200 bg-white p-5"
				>
					<div class="flex flex-wrap items-baseline gap-2">
						<Badge tone="neutral">{KIND_LABEL[post.kind]()}</Badge>
						<time datetime={post.publishedAt.toISOString()} class="text-sm text-neutral-500">
							{formatDate(post.publishedAt, data.locale)}
						</time>
						{#if post.isTranslationFallback}
							<FallbackNotice locale={post.translationLocale} />
						{/if}
					</div>

					<h2 class="mt-2 font-medium">{post.title}</h2>
					<!-- Plain text, for the same reason as the FAQ. -->
					<p class="mt-1 whitespace-pre-line text-neutral-600">{post.body}</p>
				</article>
			</li>
		{/each}
	</ol>
{/if}
