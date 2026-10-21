<script lang="ts">
  import type { Snippet } from 'svelte';

  // An icon button that opens a panel below it. Closes on Escape and on a click outside.
  let {
    label,
    icon,
    count,
    children,
  }: { label: string; icon: Snippet; count?: number; children: Snippet } = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();

  function onwindowclick(event: MouseEvent) {
    // A click that removed its own target (e.g. a confirm row re-rendering) is still inside.
    const target = event.target as Node;
    if (open && target.isConnected && !root?.contains(target)) open = false;
  }

  function onwindowkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') open = false;
  }
</script>

<svelte:window onclick={onwindowclick} onkeydown={onwindowkeydown} />

<div class="popover" bind:this={root}>
  <button
    type="button"
    class="icon-button"
    class:with-count={count !== undefined}
    aria-label={label}
    title={label}
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {@render icon()}
    {#if count !== undefined}<span>{count}</span>{/if}
  </button>
  {#if open}
    <div class="panel" role="dialog" aria-label={label}>
      {@render children()}
    </div>
  {/if}
</div>
