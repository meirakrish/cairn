<script lang="ts">
  import { resolve } from '$app/paths';
  import { SourceEvent, type Source } from '@cairn/shared';
  import { deleteSource, uploadSource } from '#lib/api.ts';
  import AskPanel from '#lib/AskPanel.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  interface Upload {
    key: number;
    name: string;
    progress: number;
    error?: string;
  }

  let sources = $state<Source[]>([]);
  let uploads = $state<Upload[]>([]);
  let live = $state<'connecting' | 'live' | 'lost'>('connecting');
  let dragging = $state(false);
  // Inline delete confirmation (no browser dialogs): the source being confirmed, and per-row errors.
  let confirming = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let rowErrors = $state<Record<string, string>>({});
  let fileInput: HTMLInputElement;
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

  // Live updates. Every (re)connect starts with a fresh snapshot, so nothing is missed while away.
  $effect(() => {
    const url = `/api/cairns/${data.cairn.id}/events`;
    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;

    const connect = () => {
      live = 'connecting';
      stream = new EventSource(url);
      stream.onopen = () => {
        live = 'live';
        delay = 2000;
      };
      stream.onmessage = (m) => apply(SourceEvent.parse(JSON.parse(m.data)));
      stream.onerror = () => {
        // The browser retries dropped connections itself; it gives up (CLOSED) on errors like 401/404.
        if (stream?.readyState !== EventSource.CLOSED) return void (live = 'connecting');
        live = 'lost';
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => {
      stream?.close();
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
{#if data.cairn.description}<p class="muted">{data.cairn.description}</p>{/if}

<AskPanel
  cairnId={data.cairn.id}
  readySources={sources.filter((s) => s.status === 'ready').length}
/>

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
  <button type="button" onclick={() => fileInput.click()}>Choose files</button>
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
    {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Disconnected, retrying'}
  </span>
</div>

{#if sources.length === 0 && live === 'live'}
  <p class="muted">No files yet. Add some to build this cairn.</p>
{:else}
  <ul class="sources">
    {#each sources as source (source.id)}
      <li>
        <div class="row">
          <span class="kind">{source.kind === 'markdown' ? 'MD' : source.kind.toUpperCase()}</span>
          <span class="name" title={source.filename}>{source.filename}</span>
          <span class="status {source.status}">{STATUS_LABEL[source.status]}</span>
          {#if deleting === source.id}
            <span class="muted">Deleting…</span>
          {:else if confirming === source.id}
            <span class="confirm">
              Delete this file?
              <button type="button" class="danger" onclick={() => remove(source)}>Delete</button>
              <button type="button" class="link" onclick={() => (confirming = null)}>Cancel</button>
            </span>
          {:else}
            <button type="button" class="link" onclick={() => (confirming = source.id)}
              >Delete</button
            >
          {/if}
        </div>
        <small class="muted"
          >{formatSize(source.size)} · added {dateFormat.format(new Date(source.createdAt))}</small
        >
        {#if source.status === 'failed' && source.error}<p class="error">{source.error}</p>{/if}
        {#if rowErrors[source.id]}<p class="error">{rowErrors[source.id]}</p>{/if}
      </li>
    {/each}
  </ul>
{/if}
