<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Logo from '#lib/Logo.svelte';
  import { paginate } from '#lib/paging.ts';
  import { sharedBadge } from '#lib/share.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const PAGE_SIZE = 12;

  // The page number lives in the URL (?page=2), so back and reload keep it.
  const shown = $derived(
    paginate(data.cairns, Number(page.url.searchParams.get('page') ?? 1), PAGE_SIZE),
  );

  function goToPage(n: number) {
    // The path is resolve('/'); only the query changes, which the rule can't see through.
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    void goto(n === 1 ? resolve('/') : `${resolve('/')}?page=${n}`);
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
</script>

{#if data.user}
  <h1>Your cairns</h1>

  {#if data.cairns.length === 0}
    <section class="empty">
      <Logo size={64} />
      <h2>No cairns yet</h2>
      <p class="muted">Create one with <strong>New cairn</strong> to start adding documents.</p>
    </section>
  {:else}
    <ul class="cairn-cards">
      {#each shown.items as cairn (cairn.id)}
        {@const badge = sharedBadge(cairn)}
        <li>
          <a href={resolve('/cairns/[id]', { id: cairn.id })}>
            <strong>{cairn.name}</strong>
            {#if cairn.description}<span class="description">{cairn.description}</span>{/if}
            <small class="muted">
              {#if badge}{badge} ·
              {/if}Created {dateFormat.format(new Date(cairn.createdAt))}
            </small>
          </a>
        </li>
      {/each}
    </ul>

    {#if shown.pages > 1}
      <nav class="pager" aria-label="Pages">
        <button type="button" disabled={shown.page === 1} onclick={() => goToPage(shown.page - 1)}
          >Previous</button
        >
        <span class="muted">Page {shown.page} of {shown.pages}</span>
        <button
          type="button"
          disabled={shown.page === shown.pages}
          onclick={() => goToPage(shown.page + 1)}>Next</button
        >
      </nav>
    {/if}
  {/if}
{:else}
  <section class="signin">
    <Logo size={96} />
    <h1>Cairn</h1>
    <p>Knowledge bases built from your documents.</p>
    {#if page.url.searchParams.get('login') === 'failed'}
      <p class="error">Sign-in failed. Please try again.</p>
    {/if}
    <!-- A plain form GET is a full page load, which the api redirects to Google. -->
    <form method="get" action="/api/auth/google/start" data-sveltekit-reload>
      <button class="primary">Sign in with Google</button>
    </form>
  </section>
{/if}
