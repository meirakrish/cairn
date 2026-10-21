<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Cairn } from '@cairn/shared';
  import { createCairn, deleteCairn, updateCairn } from '#lib/api.ts';

  // A modal <dialog> (focus trapped, Escape closes) for a new cairn, or for renaming one.
  // Creating opens the new cairn; saving refreshes every load (sidebar and page).
  let dialog = $state<HTMLDialogElement>();
  let editing = $state<Cairn | undefined>();
  let name = $state('');
  let description = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  // Inline delete confirmation (no browser dialogs).
  let confirmingDelete = $state(false);
  let deleting = $state(false);

  export function open(cairn?: Cairn) {
    editing = cairn;
    name = cairn?.name ?? '';
    description = cairn?.description ?? '';
    error = null;
    confirmingDelete = false;
    dialog?.showModal();
  }

  async function remove() {
    if (!editing) return;
    deleting = true;
    error = null;
    try {
      await deleteCairn(editing.id);
      dialog?.close();
      await invalidateAll();
      await goto(resolve('/'));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not delete the cairn.';
      confirmingDelete = false;
    } finally {
      deleting = false;
    }
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
    if (event.target === dialog && !saving && !deleting) dialog.close();
  }
</script>

<dialog class="modal" bind:this={dialog} aria-labelledby="cairn-dialog-title" {onclick}>
  <form class="create" {onsubmit}>
    <h2 id="cairn-dialog-title">{editing ? 'Edit cairn' : 'New cairn'}</h2>
    <label>
      Name
      <input bind:value={name} required maxlength="100" placeholder="e.g. Tax documents" />
    </label>
    <label>
      Description <span class="muted">(optional)</span>
      <textarea bind:value={description} maxlength="1000" rows="3"></textarea>
    </label>
    {#if error}<p class="error">{error}</p>{/if}
    {#if editing}
      <div class="delete-cairn">
        {#if confirmingDelete}
          <p class="muted">
            Delete “{editing.name}” with all its files, shares and quiz history? This can't be
            undone.
          </p>
          <span class="confirm">
            <button type="button" class="danger" disabled={deleting} onclick={remove}
              >{deleting ? 'Deleting…' : 'Delete cairn'}</button
            >
            <button
              type="button"
              class="link"
              disabled={deleting}
              onclick={() => (confirmingDelete = false)}>Keep it</button
            >
          </span>
        {:else}
          <button type="button" class="link" onclick={() => (confirmingDelete = true)}
            >Delete this cairn…</button
          >
        {/if}
      </div>
    {/if}
    <div class="actions">
      <button type="button" disabled={saving || deleting} onclick={() => dialog?.close()}
        >Cancel</button
      >
      <button class="primary" disabled={saving || deleting || !name.trim()}>
        {#if editing}{saving ? 'Saving…' : 'Save'}{:else}{saving
            ? 'Creating…'
            : 'Create cairn'}{/if}
      </button>
    </div>
  </form>
</dialog>
