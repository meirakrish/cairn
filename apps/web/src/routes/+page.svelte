<script lang="ts">
  import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

{#if data.user}
  <p>Signed in as {data.user.email}.</p>
{:else}
  <section class="signin">
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
