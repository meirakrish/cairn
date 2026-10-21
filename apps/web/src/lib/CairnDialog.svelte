<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Cairn } from '@cairn/shared';
  import { createCairn, updateCairn } from '#lib/api.ts';

  // A modal <dialog> (focus trapped, Escape closes) for a new cairn, or for renaming one.
  // Creating opens the new cairn; saving refreshes every load (sidebar and page).
  let dialog = $state<HTMLDialogElement>();
  let editing = $state<Cairn | undefined>();
  let name = $state('');
  let description = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  export function open(cairn?: Cairn) {
    editing = cairn;
    name = cairn?.name ?? '';
    description = cairn?.description ?? '';
    error = null;
    dialog?.showModal();
  }

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      if (editing) {
        await updateCairn(editing.id, { name, description });
        dialog?.close();
        await invalidateAll();
      } else {
        const cairn = await createCairn({ name, description });
        dialog?.close();
        await invalidateAll();
        await goto(resolve('/cairns/[id]', { id: cairn.id }));
      }
    } catch (err) {
      const fallback = editing ? 'Could not save the cairn.' : 'Could not create the cairn.';
      error = err instanceof Error ? err.message : fallback;
    } finally {
      saving = false;
    }
  }

  // A click on the backdrop lands on the <dialog> itself, outside its content box.
  function onclick(event: MouseEvent) {
    if (event.target === dialog && !saving) dialog.close();
  }
</script>

<dialog class="modal" bind:this={dialog} aria-labelledby="cairn-dialog-title" {onclick}>
  <form class="create" {onsubmit}>
    <h2 id="cairn-dialog-title">{editing ? 'Edit cairn' : 'New cairn'}</h2>
    <label>
      Name
      <input
        bind:value={name}
        dir="auto"
        required
        maxlength="100"
        placeholder="e.g. Tax documents"
      />
    </label>
    <label>
      Description <span class="muted">(optional)</span>
      <textarea bind:value={description} dir="auto" maxlength="1000" rows="3"></textarea>
    </label>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" disabled={saving} onclick={() => dialog?.close()}>Cancel</button>
      <button class="primary" disabled={saving || !name.trim()}>
        {#if editing}{saving ? 'Saving…' : 'Save'}{:else}{saving
            ? 'Creating…'
            : 'Create cairn'}{/if}
      </button>
    </div>
  </form>
</dialog>
