<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Cairn, User } from '@cairn/shared';
  import AccountMenu from '#lib/AccountMenu.svelte';
  import Logo from '#lib/Logo.svelte';
  import { accessLabel } from '#lib/share.ts';

  // The app's left column: logo, New cairn, the cairn list, and the account menu at the bottom.
  // open: shown as a drawer on narrow screens (the top bar's menu button).
  let {
    user,
    cairns,
    open = false,
    onnew,
    onsignout,
  }: {
    user: User;
    cairns: Cairn[];
    open?: boolean;
    onnew: () => void;
    onsignout: () => Promise<void>;
  } = $props();

  const own = $derived(cairns.filter((c) => c.role === 'owner'));
  const shared = $derived(cairns.filter((c) => c.role !== 'owner'));
</script>

<nav id="sidebar" class="sidebar" class:open aria-label="Cairns">
  <a class="brand" href={resolve('/')}><Logo size={28} />Cairn</a>
  <button type="button" class="new-cairn" onclick={onnew}>
    <svg class="icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M12 5v14M5 12h14" /></svg
    >
    New cairn
  </button>
  <div class="lists">
    {#if own.length === 0}
      <p class="muted">None yet.</p>
    {:else}
      <ul>
        {#each own as cairn (cairn.id)}
          {@const current = page.params.id === cairn.id}
          <li>
            <a
              href={resolve('/cairns/[id]', { id: cairn.id })}
              class:current
              aria-current={current ? 'page' : undefined}>{cairn.name}</a
            >
          </li>
        {/each}
      </ul>
    {/if}

    {#if shared.length}
      <h2>Shared with you</h2>
      <ul>
        {#each shared as cairn (cairn.id)}
          {@const current = page.params.id === cairn.id}
          <li>
            <a
              href={resolve('/cairns/[id]', { id: cairn.id })}
              class:current
              aria-current={current ? 'page' : undefined}
              ><span class="name">{cairn.name}</span><span class="access">{accessLabel(cairn)}</span
              ></a
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <AccountMenu {user} {onsignout} />
</nav>
