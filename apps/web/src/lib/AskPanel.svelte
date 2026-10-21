<script lang="ts">
  import type { CitedPassage } from '@cairn/shared';
  import { describeLocation, pageLink, splitCitations } from './answer';
  import { askQuestion } from './api';
  import ExternalLink from './ExternalLink.svelte';

  // Sealed: text-only answers, and no way to know which files are ready, so asking is always on.
  // onattach: shown as a paperclip in the question box, for callers who can add files.
  let {
    cairnId,
    readySources,
    sealed = false,
    onattach,
  }: { cairnId: string; readySources: number; sealed?: boolean; onattach?: () => void } = $props();

  const canAsk = $derived(sealed || readySources > 0);

  type Phase = 'idle' | 'searching' | 'writing' | 'done' | 'stopped' | 'error';

  let question = $state('');
  let asked = $state('');
  let answer = $state('');
  let passages = $state<CitedPassage[]>([]);
  let cited = $state<number[]>([]);
  let phase = $state<Phase>('idle');
  let error = $state<string | null>(null);
  let open = $state<number | null>(null);
  let controller: AbortController | undefined;

  const busy = $derived(phase === 'searching' || phase === 'writing');
  const segments = $derived(splitCitations(answer, passages.length));
  const citedPassages = $derived(cited.map((n) => passages[n - 1]).filter((p) => p !== undefined));
  const openPassage = $derived(open === null ? undefined : passages[open - 1]);

  async function ask(event?: SubmitEvent) {
    event?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    controller?.abort();
    controller = new AbortController();
    asked = q;
    answer = '';
    passages = [];
    cited = [];
    open = null;
    error = null;
    phase = 'searching';
    try {
      await askQuestion(
        cairnId,
        q,
        sealed,
        (e) => {
          if (e.type === 'passages') {
            passages = e.passages;
            phase = 'writing';
          } else if (e.type === 'delta') {
            answer += e.text;
            phase = 'writing';
          } else if (e.type === 'done') {
            cited = 'cited' in e ? e.cited : [];
            phase = 'done';
          } else {
            error = e.message;
            phase = 'error';
          }
        },
        controller.signal,
      );
      // The stream ended without a final event: the connection dropped.
      if (phase === 'searching' || phase === 'writing') {
        error = 'The answer was cut off. Please ask again.';
        phase = 'error';
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      error = err instanceof Error ? err.message : 'Could not ask the question.';
      phase = 'error';
    }
  }

  function stop() {
    controller?.abort();
    phase = 'stopped';
  }

  function onkeydown(e: KeyboardEvent) {
    // Enter asks; Shift+Enter starts a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask();
    }
  }

  function toggle(n: number) {
    open = open === n ? null : n;
  }

  // Leaving the page stops a running answer.
  $effect(() => () => controller?.abort());
</script>

<section class="ask" aria-label="Ask this cairn">
  <form onsubmit={ask}>
    <div class="ask-box">
      {#if onattach}
        <button
          type="button"
          class="icon-button attach"
          aria-label="Attach files"
          title="Attach files"
          onclick={onattach}
        >
          <svg class="icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
            ><path
              d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"
            /></svg
          >
        </button>
      {/if}
      <textarea
        bind:value={question}
        {onkeydown}
        rows="2"
        maxlength="1000"
        aria-label="Question"
        placeholder={canAsk
          ? 'Ask a question about these files…'
          : 'Add files and wait until they are ready to ask questions'}
        disabled={!canAsk}></textarea>
      {#if busy}
        <button type="button" onclick={stop}>Stop</button>
      {:else}
        <button class="primary" disabled={!canAsk || !question.trim()}>Ask</button>
      {/if}
    </div>
    <small class="muted">
      {#if busy}
        {phase === 'searching' ? 'Searching…' : 'Writing…'}
      {:else if sealed}
        Answers only: sources are not shown for this cairn.
      {:else}
        Enter to ask, Shift+Enter for a new line{onattach
          ? '. Drop files anywhere to add them.'
          : ''}
      {/if}
    </small>
  </form>

  {#if phase !== 'idle'}
    <article class="answer" aria-live="polite">
      <p class="asked">{asked}</p>
      {#if answer}
        <p class="text">
          {#each segments as segment, i (i)}
            {#if 'cite' in segment}
              <button
                type="button"
                class="cite"
                class:active={open === segment.cite}
                aria-expanded={open === segment.cite}
                title={passages[segment.cite - 1]?.filename}
                onclick={() => toggle(segment.cite)}>{segment.cite}</button
              >
            {:else}{segment.text}{/if}
          {/each}
        </p>
      {/if}
      {#if phase === 'stopped'}<p class="muted">Stopped.</p>{/if}
      {#if error}<p class="error">{error}</p>{/if}

      {#if openPassage}
        <blockquote class="passage">
          <header>
            <strong>[{open}] {openPassage.filename}</strong>
            {#if describeLocation(openPassage.location)}
              <span class="muted">· {describeLocation(openPassage.location)}</span>
            {/if}
            {#if openPassage.url}
              {@const link = pageLink(openPassage.url, openPassage.text)}
              {#if link}<ExternalLink href={link} title={openPassage.url}>Open page</ExternalLink
                >{/if}
            {/if}
            <button type="button" class="link" onclick={() => (open = null)}>Close</button>
          </header>
          {#if openPassage.kind === 'image'}
            <!-- Cited answers only: sealed answers have no passages, and the api refuses them files. -->
            <img
              class="preview"
              src="/api/cairns/{cairnId}/sources/{openPassage.sourceId}/file"
              alt="The image this passage describes: {openPassage.filename}"
              loading="lazy"
            />
          {/if}
          <p>{openPassage.text}</p>
        </blockquote>
      {/if}

      {#if phase === 'done' && citedPassages.length}
        <div class="cited">
          <small class="muted">Sources</small>
          <ul>
            {#each citedPassages as passage (passage.n)}
              <li>
                <button type="button" class="link" onclick={() => toggle(passage.n)}>
                  [{passage.n}] {passage.filename}{describeLocation(passage.location)
                    ? ` · ${describeLocation(passage.location)}`
                    : ''}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </article>
  {/if}
</section>
