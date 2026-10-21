<script lang="ts">
  import type { Snippet } from 'svelte';

  // A link to a page outside Cairn (a web source), opened in a new tab without access back to this
  // one. Only http(s) URLs become links; anything else renders as plain text.
  let {
    href,
    title,
    class: className,
    children,
  }: { href: string; title?: string; class?: string; children: Snippet } = $props();

  const safe = $derived(/^https?:\/\//i.test(href));
</script>

{#if safe}
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external page, not an app route -->
  <a {href} class={className} {title} target="_blank" rel="noopener noreferrer"
    >{@render children()}</a
  >
{:else}
  <span class={className} {title}>{@render children()}</span>
{/if}
