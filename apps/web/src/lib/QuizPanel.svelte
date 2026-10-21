<script lang="ts">
  import { untrack } from 'svelte';
  import type { QuizQuestion, QuizResult } from '@cairn/shared';
  import { describeLocation, pageLink } from './answer';
  import { answerQuiz, newQuizQuestion } from './api';
  import Confetti from './Confetti.svelte';
  import ExternalLink from './ExternalLink.svelte';
  import {
    cheer,
    describeScore,
    optionLetter,
    streak,
    tally,
    VERDICT_LABEL,
    type Outcome,
  } from './quiz';

  let { cairnId, readySources }: { cairnId: string; readySources: number } = $props();

  // setup: before the quiz; loading: the next question (from the bank, or written by the model);
  // asking: waiting for a pick; checking: sent; result: verdict shown; summary: quiz ended.
  type Phase = 'setup' | 'loading' | 'asking' | 'checking' | 'result' | 'summary';

  let phase = $state<Phase>('setup');
  let question = $state<QuizQuestion | null>(null);
  let picked = $state<number | null>(null);
  let result = $state<QuizResult | null>(null);
  let outcomes = $state<Outcome[]>([]);
  let error = $state<string | null>(null);
  let showPassage = $state(false);
  let controller: AbortController | undefined;
  let started = false;

  const score = $derived(tally(outcomes));
  const party = $derived(cheer(score));
  const inARow = $derived(streak(outcomes));
  const canQuiz = $derived(readySources > 0);

  const message = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;

  function begin() {
    started = true;
    outcomes = [];
    void next();
  }

  function start(event: SubmitEvent) {
    event.preventDefault();
    begin();
  }

  // Opening the quiz shows the first question right away (from the bank, or written by the model);
  // if no file is ready yet, it starts when the first one is. Only once: after End quiz, wait.
  $effect(() => {
    if (canQuiz && !started) untrack(begin);
  });

  async function next() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    question = null;
    result = null;
    picked = null;
    showPassage = false;
    error = null;
    phase = 'loading';
    try {
      question = await newQuizQuestion(cairnId, signal);
      phase = 'asking';
    } catch (err) {
      if (signal.aborted) return;
      error = message(err, 'Could not write a question.');
    }
  }

  async function pick(choice: number) {
    if (!question || phase !== 'asking') return;
    picked = choice;
    controller = new AbortController();
    const { signal } = controller;
    error = null;
    phase = 'checking';
    try {
      result = await answerQuiz(cairnId, question.id, choice, signal);
      outcomes = [...outcomes, result.verdict];
      phase = 'result';
    } catch (err) {
      if (signal.aborted) return;
      error = message(err, 'Could not check the answer.');
      phase = 'asking';
    }
  }

  function skip() {
    if (question) outcomes = [...outcomes, 'skipped'];
    void next();
  }

  function end() {
    controller?.abort();
    // A question on screen but not answered is simply dropped.
    phase = outcomes.length ? 'summary' : 'setup';
    error = null;
  }

  function optionState(i: number): string {
    if (!result) return picked === i ? 'picked' : '';
    if (i === result.correctChoice) return 'right';
    return i === picked ? 'wrong' : '';
  }

  // Leaving the page stops a question being written.
  $effect(() => () => controller?.abort());
</script>

<section class="quiz" aria-label="Quiz on this cairn">
  {#if phase === 'setup'}
    <form class="quiz-setup" onsubmit={start}>
      <p>
        Test yourself on this cairn's files: multiple-choice questions, each from a passage picked
        at random.
      </p>
      <div class="actions">
        <button class="primary" disabled={!canQuiz}>Start quiz</button>
        {#if !canQuiz}
          <small class="muted">Add files and wait until they are ready to start a quiz.</small>
        {/if}
      </div>
    </form>
  {:else if phase === 'summary'}
    <div class="quiz-summary">
      {#if party.party}<Confetti pieces={48} />{/if}
      <p class="trophy" aria-hidden="true">{party.emoji}</p>
      <h2>{party.title}</h2>
      <p class="score-big">{describeScore(score)}</p>
      <div class="actions">
        <button class="primary" type="button" onclick={begin}>New quiz</button>
      </div>
    </div>
  {:else}
    <div class="quiz-bar">
      <small class="muted">
        Question {outcomes.length + (phase === 'result' ? 0 : 1)}
        {#if outcomes.length}· {describeScore(score)}{/if}
      </small>
    </div>

    {#if phase === 'loading'}
      {#if error}
        <p class="error">{error}</p>
        <div class="actions">
          <button type="button" class="primary" onclick={() => void next()}>Try again</button>
          <span class="end-group">
            <button type="button" class="link" onclick={end}>End quiz</button>
          </span>
        </div>
      {:else}
        <p class="muted" aria-live="polite">Writing a question…</p>
      {/if}
    {:else if question}
      <article class="quiz-card" aria-live="polite">
        {#if question.seenBefore}
          <span
            class="badge seen"
            title="You've seen every question for these files; this one repeats">Asked before</span
          >
        {/if}
        <p class="quiz-question" dir="auto">{question.question}</p>

        <ol class="options">
          {#each question.choices as choice, i (i)}
            <li>
              <button
                type="button"
                class="option {optionState(i)}"
                disabled={phase !== 'asking'}
                onclick={() => pick(i)}
              >
                <span class="letter">{optionLetter(i)}</span>
                <span dir="auto">{choice}</span>
              </button>
            </li>
          {/each}
        </ol>
        {#if phase === 'checking'}<p class="muted">Checking…</p>{/if}
        {#if error}<p class="error">{error}</p>{/if}

        {#if result}
          <div class="verdict {result.verdict}">
            {#if result.verdict === 'correct'}<Confetti />{/if}
            <strong
              >{VERDICT_LABEL[result.verdict]}{result.verdict === 'correct' ? ' 🎉' : ''}</strong
            >
            {#if result.verdict === 'correct' && inARow >= 2}
              <span class="streak">{inARow} in a row 🔥</span>
            {/if}
            <p dir="auto">{result.explanation}</p>
          </div>

          {#if showPassage}
            <blockquote class="passage">
              <header>
                <strong><bdi>{result.passage.filename}</bdi></strong>
                {#if describeLocation(result.passage.location)}
                  <span class="muted">· {describeLocation(result.passage.location)}</span>
                {/if}
                {#if result.passage.url}
                  {@const link = pageLink(result.passage.url, result.passage.text)}
                  {#if link}<ExternalLink href={link} title={result.passage.url}
                      >Open page</ExternalLink
                    >{/if}
                {/if}
                <button type="button" class="link" onclick={() => (showPassage = false)}
                  >Close</button
                >
              </header>
              {#if result.passage.kind === 'image'}
                <img
                  class="preview"
                  src="/api/cairns/{cairnId}/sources/{result.passage.sourceId}/file"
                  alt="The image this passage describes: {result.passage.filename}"
                  loading="lazy"
                />
              {/if}
              <p dir="auto">{result.passage.text}</p>
            </blockquote>
          {/if}
        {/if}

        <div class="actions">
          {#if phase === 'result'}
            <button type="button" class="primary" onclick={() => void next()}>Next question</button>
            {#if !showPassage}
              <button type="button" class="link" onclick={() => (showPassage = true)}>
                Show the passage
              </button>
            {/if}
          {/if}
          <span class="end-group">
            {#if phase === 'asking'}
              <button type="button" class="link" onclick={skip}>Skip</button>
            {/if}
            <button type="button" class="link" onclick={end}>End quiz</button>
          </span>
        </div>
      </article>
    {/if}
  {/if}
</section>
