<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Logo from '#lib/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Shared cairn · Cairn</title>
</svelte:head>

{#if data.state === 'signin'}
  <section class="signin">
    <Logo size={96} />
    <h1>A cairn was shared with you</h1>
    <p>Sign in with Google to open it.</p>
    <!-- A plain form GET is a full page load; the api sends you back to this link afterwards. -->
    <form method="get" action="/api/auth/google/start" data-sveltekit-reload>
      <input type="hidden" name="returnTo" value={page.url.pathname} />
      <button class="primary">Sign in with Google</button>
    </form>
  </section>
{:else}
  <section class="error-page">
    <h1>This link doesn't work</h1>
    <p class="muted">
      It may have expired or been revoked. Ask the person who shared it for a new one.
    </p>
    <a href={resolve('/')}>Go to your cairns</a>
  </section>
{/if}
