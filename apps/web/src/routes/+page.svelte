<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { createCairn } from '#lib/api.ts';
  import Logo from '#lib/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let name = $state('');
  let description = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      await createCairn({ name, description });
      name = '';
      description = '';
      await invalidateAll();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create the cairn.';
    } finally {
      saving = false;
    }
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
</script>

{#if data.user}
  <h1>Your cairns</h1>

  <form class="create" {onsubmit}>
    <label>
      Name
      <input bind:value={name} required maxlength="100" placeholder="e.g. Tax documents" />
    </label>
    <label>
      Description <span class="muted">(optional)</span>
      <textarea bind:value={description} maxlength="1000" rows="2"></textarea>
    </label>
    <div class="actions">
      <button class="primary" disabled={saving || !name.trim()}>
        {saving ? 'Creating…' : 'Create cairn'}
      </button>
      {#if error}<span class="error">{error}</span>{/if}
    </div>
  </form>

  {#if data.cairns.length === 0}
    <p class="muted">No cairns yet. Create one to start adding documents.</p>
  {:else}
    <ul class="cairns">
      {#each data.cairns as cairn (cairn.id)}
        <li>
          <strong>{cairn.name}</strong>
          {#if cairn.description}<p>{cairn.description}</p>{/if}
          <small class="muted">Created {dateFormat.format(new Date(cairn.createdAt))}</small>
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <section class="signin">
    <Logo size={96} />
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
