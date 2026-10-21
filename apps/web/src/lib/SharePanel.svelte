<script lang="ts">
  import type { Share, ShareRole, Visibility } from '@cairn/shared';
  import { createShare, listShares, revokeShare } from './api';
  import { describeShare, expiryDate, EXPIRY_OPTIONS, type Expiry } from './share';

  let { cairnId }: { cairnId: string } = $props();

  let shares = $state<Share[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let kind = $state<'email' | 'link'>('email');
  let email = $state('');
  let role = $state<ShareRole>('viewer');
  let visibility = $state<Visibility>('cited');
  let expiry = $state<Expiry>('never');
  let saving = $state(false);
  let formError = $state<string | null>(null);

  // The link of the share just created; its token is never shown again.
  let newLink = $state<{ id: string; url: string } | null>(null);
  let copied = $state(false);

  // Inline revoke confirmation (no browser dialogs), and per-row errors.
  let confirming = $state<string | null>(null);
  let revoking = $state<string | null>(null);
  let rowErrors = $state<Record<string, string>>({});

  // Editors see sources, so an editor share is always cited.
  $effect(() => {
    if (role === 'editor') visibility = 'cited';
  });

  async function load() {
    try {
      shares = await listShares(cairnId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not load the shares.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    formError = null;
    newLink = null;
    copied = false;
    const options = { role, visibility, expiresAt: expiryDate(expiry) };
    try {
      if (kind === 'email') {
        await createShare(cairnId, { kind, email, ...options });
        email = '';
      } else {
        const { share, token } = await createShare(cairnId, { kind, ...options });
        newLink = { id: share.id, url: `${location.origin}/s/${token}` };
      }
      await load();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Could not share the cairn.';
    } finally {
      saving = false;
    }
  }

  async function copy() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink.url);
      copied = true;
    } catch {
      formError = 'Could not copy; select the link and copy it by hand.';
    }
  }

  async function revoke(share: Share) {
    confirming = null;
    revoking = share.id;
    delete rowErrors[share.id];
    try {
      await revokeShare(cairnId, share.id);
      shares = shares.filter((s) => s.id !== share.id);
      if (newLink?.id === share.id) newLink = null;
    } catch (err) {
      rowErrors = {
        ...rowErrors,
        [share.id]: err instanceof Error ? err.message : 'Could not revoke the share.',
      };
    } finally {
      revoking = null;
    }
  }
</script>

<section class="share" aria-label="Sharing">
  <h2>Sharing</h2>

  <form {onsubmit}>
    <div class="kinds" role="radiogroup" aria-label="Share with">
      <label><input type="radio" bind:group={kind} value="email" /> A Google account</label>
      <label><input type="radio" bind:group={kind} value="link" /> Anyone with a link</label>
    </div>

    {#if kind === 'email'}
      <label>
        Email
        <input
          type="email"
          bind:value={email}
          required
          maxlength="254"
          placeholder="name@example.com"
          autocomplete="off"
        />
      </label>
    {:else}
      <p class="muted">People who open the link sign in with Google first.</p>
    {/if}

    <div class="options">
      <label>
        Can
        <select bind:value={role}>
          <option value="viewer">Ask questions</option>
          <option value="editor">Ask and add files</option>
        </select>
      </label>
      <label>
        Answers
        <select bind:value={visibility} disabled={role === 'editor'}>
          <option value="cited">Show sources</option>
          <option value="sealed">Hide sources</option>
        </select>
      </label>
      <label>
        Expires
        <select bind:value={expiry}>
          {#each EXPIRY_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="actions">
      <button class="primary" disabled={saving || (kind === 'email' && !email.trim())}>
        {saving ? 'Sharing…' : kind === 'email' ? 'Share' : 'Create link'}
      </button>
      {#if formError}<span class="error">{formError}</span>{/if}
    </div>
  </form>

  {#if newLink}
    <div class="new-link">
      <input
        readonly
        value={newLink.url}
        aria-label="Share link"
        onfocus={(e) => e.currentTarget.select()}
      />
      <button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <small class="muted"
        >Copy it now: the link isn't shown again. Revoke it to stop it working.</small
      >
    </div>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if loadError}
    <p class="error">{loadError}</p>
  {:else if shares.length === 0}
    <p class="muted">Only you can see this cairn.</p>
  {:else}
    <ul class="shares">
      {#each shares as share (share.id)}
        {@const info = describeShare(share)}
        <li>
          <div class="row">
            <span class="who">{info.who}</span>
            <span class="muted">{info.access}</span>
            {#if revoking === share.id}
              <span class="muted">Revoking…</span>
            {:else if confirming === share.id}
              <span class="confirm">
                Revoke access?
                <button type="button" class="danger" onclick={() => revoke(share)}>Revoke</button>
                <button type="button" class="link" onclick={() => (confirming = null)}
                  >Cancel</button
                >
              </span>
            {:else}
              <button type="button" class="link" onclick={() => (confirming = share.id)}
                >Revoke</button
              >
            {/if}
          </div>
          {#if info.detail}<small class="muted" class:error={info.expired}>{info.detail}</small
            >{/if}
          {#if rowErrors[share.id]}<p class="error">{rowErrors[share.id]}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
