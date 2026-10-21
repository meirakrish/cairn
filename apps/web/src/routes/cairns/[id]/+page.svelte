<script lang="ts">
  import { resolve } from '$app/paths';
  import { SourceEvent, type Source } from '@cairn/shared';
  import { sseData } from '#lib/answer.ts';
  import { deleteSource, uploadSource } from '#lib/api.ts';
  import AskPanel from '#lib/AskPanel.svelte';
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
  let dragging = $state(false);
  // Inline delete confirmation (no browser dialogs): the source being confirmed, and per-row errors.
  let confirming = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let rowErrors = $state<Record<string, string>>({});
  let fileInput = $state<HTMLInputElement>();
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

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void addFiles(event.dataTransfer?.files);
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

<a class="back" href={resolve('/')}>← Your cairns</a>
<h1>{data.cairn.name}</h1>
{#if badge}<span class="badge">{badge}</span>{/if}
{#if data.cairn.description}<p class="muted">{data.cairn.description}</p>{/if}

<AskPanel
  cairnId={data.cairn.id}
  readySources={sources.filter((s) => s.status === 'ready').length}
  {sealed}
/>

{#if !sealed}
  {#if canUpload}
    <div
      class="dropzone"
      class:dragging
      role="region"
      aria-label="Upload files"
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      {ondrop}
    >
      <p>Drop text, Markdown or PDF files here</p>
      <button type="button" onclick={() => fileInput?.click()}>Choose files</button>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
        hidden
        onchange={(e) => {
          void addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <small class="muted"
        >Up to 25 MB each. Scanned PDFs without a text layer are not supported yet.</small
      >
    </div>
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

  <div class="sources-header">
    <h2>Files</h2>
    <span class="live {live}" title="Status updates">
      {live === 'live'
        ? 'Live'
        : live === 'connecting'
          ? 'Connecting…'
          : live === 'busy'
            ? 'Paused: Cairn is open in too many tabs'
            : 'Disconnected, retrying'}
    </span>
  </div>

  {#if sources.length === 0 && live === 'live'}
    <p class="muted">No files yet.{canUpload ? ' Add some to build this cairn.' : ''}</p>
  {:else}
    <ul class="sources">
      {#each sources as source (source.id)}
        <li>
          <div class="row">
            <span class="kind">{source.kind === 'markdown' ? 'MD' : source.kind.toUpperCase()}</span
            >
            <span class="name" title={source.filename}>{source.filename}</span>
            <span class="status {source.status}">{STATUS_LABEL[source.status]}</span>
            {#if !isOwner}
              <!-- Only the owner deletes files. -->
            {:else if deleting === source.id}
              <span class="muted">Deleting…</span>
            {:else if confirming === source.id}
              <span class="confirm">
                Delete this file?
                <button type="button" class="danger" onclick={() => remove(source)}>Delete</button>
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
            >{formatSize(source.size)} · added {dateFormat.format(
              new Date(source.createdAt),
            )}</small
          >
          {#if source.status === 'failed' && source.error}<p class="error">{source.error}</p>{/if}
          {#if rowErrors[source.id]}<p class="error">{rowErrors[source.id]}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if isOwner}
  <SharePanel cairnId={data.cairn.id} />
{/if}
