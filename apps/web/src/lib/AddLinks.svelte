<script lang="ts">
  import type { Source } from '@cairn/shared';
  import { addUrl, DuplicateUrlError, refreshSource } from './api';

  // The form inside the Add links popover. onadded gets each new or refreshed source, so the file
  // list shows it before its first live update arrives.
  let { cairnId, onadded }: { cairnId: string; onadded: (source: Source) => void } = $props();

  interface Problem {
    url: string;
    message: string;
    /** The page is already in the cairn: offer to refresh it. */
    existing?: Source;
  }

  const MAX_LINKS = 20;

  let text = $state('');
  let adding = $state(false);
  let problems = $state<Problem[]>([]);
  let added = $state(0);

  // "example.com/a" means https://example.com/a; anything with a scheme is left for the api to judge.
  const withScheme = (url: string) => (/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const urls = [...new Set(text.split(/\s+/).filter(Boolean).map(withScheme))];
    if (urls.length === 0 || adding) return;
    adding = true;
    added = 0;
    problems = [];
    if (urls.length > MAX_LINKS) {
      problems = [{ url: '', message: `Add up to ${MAX_LINKS} links at a time.` }];
      adding = false;
      return;
    }
    const failed: Problem[] = [];
    // One at a time, like uploads: errors stay in order and readable.
    for (const url of urls) {
      try {
        onadded(await addUrl(cairnId, url));
        added++;
      } catch (err) {
        failed.push({
          url,
          message: err instanceof Error ? err.message : 'Could not add the page.',
          existing: err instanceof DuplicateUrlError ? err.source : undefined,
        });
      }
    }
    problems = failed;
    // Keep what failed, so it can be fixed and added again.
    text = failed
      .filter((p) => !p.existing)
      .map((p) => p.url)
      .join('\n');
    adding = false;
  }

  async function refresh(problem: Problem) {
    try {
      onadded(await refreshSource(cairnId, problem.existing!.id));
      problems = problems.filter((p) => p !== problem);
      added++;
    } catch (err) {
      problems = problems.map((p) =>
        p === problem
          ? {
              ...p,
              existing: undefined,
              message: err instanceof Error ? err.message : 'Could not refresh the page.',
            }
          : p,
      );
    }
  }
</script>

<form class="add-links" onsubmit={add}>
  <h2>Add web pages</h2>
  <textarea
    bind:value={text}
    rows="3"
    aria-label="Web addresses, one per line"
    placeholder="https://example.com/page (one per line)"
    disabled={adding}></textarea>
  <div class="actions">
    <button class="primary" disabled={adding || !text.trim()}>{adding ? 'Adding…' : 'Add'}</button>
    {#if added && !adding}<span class="muted"
        >{added === 1 ? 'Added 1 page' : `Added ${added} pages`}; it shows in Files while it is
        fetched.</span
      >{/if}
  </div>
  {#if problems.length}
    <ul class="problems">
      {#each problems as problem (problem.url)}
        <li>
          {#if problem.url}<span class="url">{problem.url}</span>{/if}
          <span class="error">{problem.message}</span>
          {#if problem.existing?.status === 'ready' || problem.existing?.status === 'failed'}
            <button type="button" class="link" onclick={() => refresh(problem)}>Refresh it</button>
          {:else if problem.existing}
            <span class="muted">It is being fetched now.</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <small class="muted"
    >Public pages only: Cairn reads the page's main text. Pages that need JavaScript or a sign-in
    can't be read. Pages aren't updated by themselves; refresh one in Files to fetch it again.</small
  >
</form>

<style>
  .add-links {
    display: grid;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .problems {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  .problems li {
    display: grid;
    gap: 0.1rem;
  }
  .problems .url {
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }
  .problems .error,
  .problems .link {
    justify-self: start;
  }
</style>
