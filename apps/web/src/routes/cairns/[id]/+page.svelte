<script lang="ts">
  import { SourceEvent, type Source } from '@cairn/shared';
  import AddLinks from '#lib/AddLinks.svelte';
  import { hostOf, sseData } from '#lib/answer.ts';
  import { deleteSource, refreshSource, uploadSource } from '#lib/api.ts';
  import AskPanel from '#lib/AskPanel.svelte';
  import CairnDialog from '#lib/CairnDialog.svelte';
  import DeleteCairnDialog from '#lib/DeleteCairnDialog.svelte';
  import ExternalLink from '#lib/ExternalLink.svelte';
  import Popover from '#lib/Popover.svelte';
  import QuizPanel from '#lib/QuizPanel.svelte';
  import { sharedBadge } from '#lib/share.ts';
  import SharePanel from '#lib/SharePanel.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // What the caller may do (the api enforces the same): sealed sees only answers; viewers see
  // files; editors add them; only the owner deletes files and manages sharing.
  const sealed = $derived(data.cairn.visibility === 'sealed');
  const canUpload = $derived(data.cairn.role !== 'viewer');
  const isOwner = $derived(data.cairn.role === 'owner');
  const badge = $derived(sharedBadge(data.cairn));

  interface Upload {
    key: number;
    name: string;
    progress: number;
    error?: string;
  }

  let sources = $state<Source[]>([]);
  let uploads = $state<Upload[]>([]);
  // busy: refused because this user has too many live views open (other tabs).
  let live = $state<'connecting' | 'live' | 'lost' | 'busy'>('connecting');
  // Files dragged over the page (anywhere): dragenter/dragleave fire per element, so count them.
  let dragging = $state(false);
  let dragDepth = 0;
  // Inline delete confirmation (no browser dialogs): the source being confirmed, and per-row errors.
  let confirming = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let refreshing = $state<string | null>(null);
  let rowErrors = $state<Record<string, string>>({});
  let fileInput = $state<HTMLInputElement>();
  let addingLinks = $state(false);
  let deleteDialog = $state<DeleteCairnDialog>();
  let editDialog = $state<CairnDialog>();
  // Ask questions, or be quizzed (callers who can see sources only; the api enforces it too).
  let mode = $state<'ask' | 'quiz'>('ask');
  let nextKey = 0;

  const byNewest = (a: Source, b: Source) => b.createdAt.localeCompare(a.createdAt);

  function upsert(source: Source) {
    sources = [...sources.filter((s) => s.id !== source.id), source].sort(byNewest);
  }

  function apply(event: SourceEvent) {
    if (event.type === 'snapshot') sources = [...event.sources].sort(byNewest);
    else if (event.type === 'source') upsert(event.source);
    else sources = sources.filter((s) => s.id !== event.sourceId);
  }

  // Live updates over fetch rather than EventSource, which hides why a connection was refused.
  // Every (re)connect starts with a fresh snapshot, so nothing is missed while away.
  $effect(() => {
    if (sealed) return;
    const url = `/api/cairns/${data.cairn.id}/events`;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;

    const reconnect = (ms = delay) => {
      retry = setTimeout(connect, ms);
      delay = Math.min(delay * 2, 30_000);
    };

    async function connect() {
      live = 'connecting';
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.status === 429) {
          // The server frees a slot as soon as another tab closes; try again after it says.
          live = 'busy';
          return reconnect(Number(res.headers.get('retry-after') || 25) * 1000);
        }
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        live = 'live';
        delay = 2000;
        for await (const message of sseData(res.body)) {
          apply(SourceEvent.parse(JSON.parse(message)));
        }
      } catch {
        // Handled below: a network error is a lost connection; an abort means the page is gone.
      }
      if (controller.signal.aborted) return;
      // The stream ended or failed (network, server restart, lost access): retry with backoff.
      live = 'lost';
      reconnect();
    }

    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  });

  async function addFiles(files: FileList | File[] | null | undefined) {
    // One at a time: the worker processes them in order anyway, and errors stay readable.
    for (const file of files ?? []) {
      const upload: Upload = { key: nextKey++, name: file.name, progress: 0 };
      uploads = [...uploads, upload];
      const update = (patch: Partial<Upload>) => {
        uploads = uploads.map((u) => (u.key === upload.key ? { ...u, ...patch } : u));
      };
      try {
        upsert(await uploadSource(data.cairn.id, file, (progress) => update({ progress })));
        uploads = uploads.filter((u) => u.key !== upload.key);
      } catch (err) {
        update({ error: err instanceof Error ? err.message : 'upload failed' });
      }
    }
  }

  function dismiss(key: number) {
    uploads = uploads.filter((u) => u.key !== key);
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function ondragenter(event: DragEvent) {
    if (!canUpload || sealed || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dragging = true;
  }

  function ondragover(event: DragEvent) {
    // Also for callers who can't upload: a file dropped on the page must not replace it.
    if (hasFiles(event)) event.preventDefault();
  }

  function ondragleave() {
    if (dragDepth > 0 && --dragDepth === 0) dragging = false;
  }

  function ondrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const wasDragging = dragging;
    dragDepth = 0;
    dragging = false;
    if (wasDragging) void addFiles(event.dataTransfer?.files);
  }

  async function remove(source: Source) {
    confirming = null;
    deleting = source.id;
    delete rowErrors[source.id];
    try {
      await deleteSource(data.cairn.id, source.id);
      sources = sources.filter((s) => s.id !== source.id);
    } catch (err) {
      rowErrors = {
        ...rowErrors,
        [source.id]: err instanceof Error ? err.message : 'Could not delete the file.',
      };
    } finally {
      deleting = null;
    }
  }

  async function refresh(source: Source) {
    refreshing = source.id;
    delete rowErrors[source.id];
    try {
      upsert(await refreshSource(data.cairn.id, source.id));
    } catch (err) {
      rowErrors = {
        ...rowErrors,
        [source.id]: err instanceof Error ? err.message : 'Could not refresh the page.',
      };
    } finally {
      refreshing = null;
    }
  }

  // Ready or failed pages can be fetched again; ones in the queue already will be.
  const canRefresh = (source: Source) =>
    canUpload && source.url !== null && (source.status === 'ready' || source.status === 'failed');

  const KIND_LABEL: Record<Source['kind'], string> = {
    text: 'TXT',
    markdown: 'MD',
    pdf: 'PDF',
    csv: 'CSV',
    json: 'JSON',
    image: 'IMG',
    web: 'WEB',
  };

  const LIVE_LABEL: Record<typeof live, string> = {
    live: 'Live',
    connecting: 'Connecting…',
    busy: 'Paused: Cairn is open in too many tabs',
    lost: 'Disconnected, retrying',
  };

  const UPLOAD_NOTE =
    'Text, Markdown, PDF, CSV, JSON or images, up to 25 MB each. Images and scanned PDF pages are read by the AI model, which takes a few seconds per page.';

  const STATUS_LABEL: Record<Source['status'], string> = {
    pending: 'Queued',
    processing: 'Processing…',
    ready: 'Ready',
    failed: 'Failed',
  };

  function formatSize(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
</script>

<svelte:head>
  <title>{data.cairn.name} · Cairn</title>
</svelte:head>

<svelte:window {ondragenter} {ondragover} {ondragleave} {ondrop} />

<div class="cairn-header">
  <div class="title">
    <div class="title-row">
      <h1>{data.cairn.name}</h1>
      {#if badge}<span class="badge">{badge}</span>{/if}
      {#if isOwner}
        <button
          type="button"
          class="icon-button small"
          aria-label="Edit name and description"
          title="Edit name and description"
          onclick={() => editDialog?.open(data.cairn)}
        >
          <svg class="icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg
          >
        </button>
        <button
          type="button"
          class="icon-button small"
          aria-label="Delete this cairn"
          title="Delete this cairn"
          onclick={() => deleteDialog?.open(data.cairn)}
        >
          <svg class="icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"
            ><path
              d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
            /></svg
          >
        </button>
      {/if}
    </div>
    {#if data.cairn.description}<p class="muted">{data.cairn.description}</p>{/if}
  </div>

  {#if !sealed}
    <Popover label="Sources" count={live === 'connecting' ? undefined : sources.length}>
      {#snippet icon()}
        <svg class="icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
          ><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path
            d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"
          /></svg
        >
      {/snippet}
      <div class="sources-header">
        <h2>Sources</h2>
        <span class="live {live}" title="Status updates">{LIVE_LABEL[live]}</span>
      </div>
      {#if canUpload}
        <div class="add-sources">
          <button type="button" onclick={() => fileInput?.click()}>
            <svg class="icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
              ><path
                d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"
              /></svg
            >
            Add files
          </button>
          <button
            type="button"
            aria-expanded={addingLinks}
            onclick={() => (addingLinks = !addingLinks)}
          >
            <svg class="icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
              ><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path
                d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
              /></svg
            >
            Add web pages
          </button>
        </div>
        {#if addingLinks}<AddLinks cairnId={data.cairn.id} onadded={upsert} />{/if}
      {/if}
      {#if sources.length === 0 && live === 'live'}
        <p class="muted">
          Nothing here yet.{canUpload ? ' Add files or web pages to build this cairn.' : ''}
        </p>
      {:else}
        <ul class="sources">
          {#each sources as source (source.id)}
            <li>
              <div class="row">
                <span class="kind">{KIND_LABEL[source.kind]}</span>
                {#if source.url}
                  <ExternalLink class="name" href={source.url} title={source.url}
                    >{source.filename}</ExternalLink
                  >
                {:else}
                  <span class="name" title={source.filename}>{source.filename}</span>
                {/if}
                <span class="status {source.status}">{STATUS_LABEL[source.status]}</span>
                {#if refreshing === source.id}
                  <span class="muted">Refreshing…</span>
                {:else if canRefresh(source) && confirming !== source.id}
                  <button type="button" class="link" onclick={() => refresh(source)}>Refresh</button
                  >
                {/if}
                {#if !isOwner}
                  <!-- Only the owner deletes files. -->
                {:else if deleting === source.id}
                  <span class="muted">Deleting…</span>
                {:else if confirming === source.id}
                  <span class="confirm">
                    Delete?
                    <button type="button" class="danger" onclick={() => remove(source)}
                      >Delete</button
                    >
                    <button type="button" class="link" onclick={() => (confirming = null)}
                      >Cancel</button
                    >
                  </span>
                {:else}
                  <button type="button" class="link" onclick={() => (confirming = source.id)}
                    >Delete</button
                  >
                {/if}
              </div>
              <small class="muted"
                >{source.url ? `${hostOf(source.url)} · ` : ''}{source.size
                  ? `${formatSize(source.size)} · `
                  : ''}added {dateFormat.format(new Date(source.createdAt))}</small
              >
              {#if source.status === 'failed' && source.error}<p class="error">
                  {source.error}
                </p>{/if}
              {#if rowErrors[source.id]}<p class="error">{rowErrors[source.id]}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if canUpload}<small class="muted">{UPLOAD_NOTE}</small>{/if}
    </Popover>
  {/if}

  {#if !sealed}
    {#if canUpload}
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.pdf,.csv,.tsv,.json,.jsonl,.ndjson,.png,.jpg,.jpeg,.webp,text/plain,text/markdown,application/pdf,text/csv,application/json,image/png,image/jpeg,image/webp"
        hidden
        onchange={(e) => {
          void addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    {/if}
  {/if}

  {#if isOwner}
    <Popover label="Share">
      {#snippet icon()}
        <svg class="icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
          ><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle
            cx="18"
            cy="19"
            r="3"
          /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg
        >
      {/snippet}
      <SharePanel cairnId={data.cairn.id} />
    </Popover>
  {/if}
</div>

{#if live === 'busy' || live === 'lost'}
  <p class="live {live}">{LIVE_LABEL[live]}</p>
{/if}

{#if uploads.length}
  <ul class="uploads">
    {#each uploads as upload (upload.key)}
      <li class:failed={upload.error}>
        <span class="name">{upload.name}</span>
        {#if upload.error}
          <span class="error">{upload.error}</span>
          <button type="button" class="link" onclick={() => dismiss(upload.key)}>Dismiss</button>
        {:else}
          <progress max="1" value={upload.progress}></progress>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if !sealed}
  <div class="mode-switch" role="tablist" aria-label="Ask questions or be tested">
    <button type="button" role="tab" aria-selected={mode === 'ask'} onclick={() => (mode = 'ask')}
      >Ask</button
    >
    <button type="button" role="tab" aria-selected={mode === 'quiz'} onclick={() => (mode = 'quiz')}
      >Test me</button
    >
  </div>
{/if}

{#if mode === 'quiz' && !sealed}
  <!-- A new cairn starts a new quiz. -->
  {#key data.cairn.id}
    <QuizPanel
      cairnId={data.cairn.id}
      readySources={sources.filter((s) => s.status === 'ready').length}
    />
  {/key}
{:else}
  <AskPanel
    cairnId={data.cairn.id}
    readySources={sources.filter((s) => s.status === 'ready').length}
    {sealed}
    onattach={canUpload && !sealed ? () => fileInput?.click() : undefined}
  />
{/if}

{#if isOwner}
  <CairnDialog bind:this={editDialog} />
  <DeleteCairnDialog bind:this={deleteDialog} />
{/if}

{#if dragging}
  <div class="drop-overlay" aria-hidden="true">
    <div>
      <strong>Drop files to add them to {data.cairn.name}</strong>
      <small>{UPLOAD_NOTE}</small>
    </div>
  </div>
{/if}
