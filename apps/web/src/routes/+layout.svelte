<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import favicon from '#lib/assets/favicon.svg';
  import { logout } from '#lib/api.ts';
  import Logo from '#lib/Logo.svelte';
  import '#lib/app.css';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  async function signOut() {
    await logout();
    await invalidateAll();
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<!-- Signed out, the sign-in screen carries the logo itself. -->
{#if data.user}
  <header>
    <a class="brand" href={resolve('/')}><Logo size={28} />Cairn</a>
    <span class="who">
      {#if data.user.avatarUrl}
        <img src={data.user.avatarUrl} alt="" referrerpolicy="no-referrer" />
      {/if}
      {data.user.name ?? data.user.email}
    </span>
    <button onclick={signOut}>Sign out</button>
  </header>
{/if}

<main>
  {@render children()}
</main>
