<script lang="ts">
  import type { User } from '@cairn/shared';

  let { user, onsignout }: { user: User; onsignout: () => Promise<void> } = $props();

  let open = $state(false);
  let signingOut = $state(false);
  let root = $state<HTMLElement>();

  // Closes on Escape and on a click anywhere outside the menu.
  function onwindowclick(event: MouseEvent) {
    if (open && !root?.contains(event.target as Node)) open = false;
  }

  function onwindowkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') open = false;
  }

  async function signOut() {
    signingOut = true;
    try {
      await onsignout();
    } finally {
      signingOut = false;
      open = false;
    }
  }
</script>

<svelte:window onclick={onwindowclick} onkeydown={onwindowkeydown} />

<div class="account" bind:this={root}>
  <button
    type="button"
    class="account-button"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {#if user.avatarUrl}
      <img src={user.avatarUrl} alt="" referrerpolicy="no-referrer" />
    {:else}
      <span class="initial" aria-hidden="true">{(user.name ?? user.email).charAt(0)}</span>
    {/if}
    <span class="who-name">{user.name ?? user.email}</span>
    <svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M6 9l6 6 6-6" /></svg
    >
  </button>
  {#if open}
    <div class="menu" role="menu">
      <div class="menu-who">
        {#if user.name}<strong dir="auto">{user.name}</strong>{/if}
        <span class="muted">{user.email}</span>
      </div>
      <button type="button" role="menuitem" disabled={signingOut} onclick={signOut}>
        <svg class="icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path
            d="M16 17l5-5-5-5M21 12H9"
          /></svg
        >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  {/if}
</div>
