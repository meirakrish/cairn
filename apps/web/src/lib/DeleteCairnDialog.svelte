<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Cairn } from '@cairn/shared';
  import { deleteCairn } from '#lib/api.ts';

  // A modal <dialog> (focus trapped, Escape closes) asking before a cairn is deleted.
  // Deleting refreshes every load and goes back to the list.
  let dialog = $state<HTMLDialogElement>();
  let cairn = $state<Cairn | undefined>();
  let deleting = $state(false);
  let error = $state<string | null>(null);

  export function open(target: Cairn) {
    cairn = target;
    error = null;
    dialog?.showModal();
  }

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!cairn) return;
    deleting = true;
    error = null;
    try {
      await deleteCairn(cairn.id);
      dialog?.close();
      await invalidateAll();
      await goto(resolve('/'));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not delete the cairn.';
    } finally {
      deleting = false;
    }
  }

  // A click on the backdrop lands on the <dialog> itself, outside its content box.
  function onclick(event: MouseEvent) {
    if (event.target === dialog && !deleting) dialog.close();
  }

  // Escape would close the dialog mid-request.
  function oncancel(event: Event) {
    if (deleting) event.preventDefault();
  }
</script>

<dialog class="modal" bind:this={dialog} aria-labelledby="delete-cairn-title" {onclick} {oncancel}>
  <form class="create" {onsubmit}>
    <h2 id="delete-cairn-title">Delete cairn</h2>
    <p>
      Delete “<bdi>{cairn?.name}</bdi>” with all its files, shares and quiz history? This can't be
      undone.
    </p>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" disabled={deleting} onclick={() => dialog?.close()}>Cancel</button>
      <button class="danger" disabled={deleting}>{deleting ? 'Deleting…' : 'Delete cairn'}</button>
    </div>
  </form>
</dialog>
