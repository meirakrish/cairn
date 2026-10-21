<script lang="ts">
  import { afterNavigate, goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import favicon from '#lib/assets/favicon.svg';
  import { logout } from '#lib/api.ts';
  import Logo from '#lib/Logo.svelte';
  import CairnDialog from '#lib/CairnDialog.svelte';
  import Sidebar from '#lib/Sidebar.svelte';
  import '#lib/app.css';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  // Narrow screens: the sidebar is a drawer behind the menu button; opening a cairn closes it.
  let sidebarOpen = $state(false);
  let newCairn = $state<CairnDialog>();
  afterNavigate(() => (sidebarOpen = false));

  async function signOut() {
    await logout();
    await goto(resolve('/'));
    await invalidateAll();
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (sidebarOpen = false)} />

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<!-- Signed out, the sign-in screen carries the logo itself. -->
{#if data.user}
  <!-- Narrow screens only: the sidebar (with the logo and account) is a drawer there. -->
  <header class="topbar">
    <button
      type="button"
      class="icon-button menu-toggle"
      aria-label="Cairns"
      aria-controls="sidebar"
      aria-expanded={sidebarOpen}
      onclick={() => (sidebarOpen = !sidebarOpen)}
    >
      <svg class="icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M4 6h16M4 12h16M4 18h16" /></svg
      >
    </button>
    <a class="brand" href={resolve('/')}><Logo size={28} />Cairn</a>
  </header>
  <div class="shell">
    <Sidebar
      user={data.user}
      cairns={data.cairns}
      open={sidebarOpen}
      onnew={() => newCairn?.open()}
      onsignout={signOut}
    />
    {#if sidebarOpen}
      <button
        type="button"
        class="sidebar-backdrop"
        aria-label="Close the cairn list"
        onclick={() => (sidebarOpen = false)}
      ></button>
    {/if}
    <main>
      {@render children()}
    </main>
  </div>
  <CairnDialog bind:this={newCairn} />
{:else}
  <main>
    {@render children()}
  </main>
{/if}
