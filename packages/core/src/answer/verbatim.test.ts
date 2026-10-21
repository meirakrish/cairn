import { describe, expect, it } from 'vitest';
import { ELISION, VerbatimFilter } from './verbatim';

const PASSAGE =
  'The quick brown fox jumps over the lazy dog while the farmer sleeps under the old oak tree.';

/** Streams `pieces` through a filter and returns what was sent after each push, and in total. */
function run(passages: string[], pieces: string[], n = 12) {
  const filter = new VerbatimFilter(passages, n);
  const sent = pieces.map((p) => filter.push(p));
  sent.push(filter.flush());
  return { sent, text: sent.join('') };
}

/** Every split of `text` into pieces of `size` characters. */
const chunked = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

describe('VerbatimFilter', () => {
  it('passes paraphrased answers through unchanged', () => {
    const answer = 'A fox leapt over a sleepy dog, and the farmer napped beneath a tree.';
    expect(run([PASSAGE], chunked(answer, 5)).text).toBe(answer);
  });

  it('replaces a copied run of 12+ words with one ellipsis, ignoring case and punctuation', () => {
    const answer =
      'In short: the QUICK brown fox, jumps over the lazy dog while the farmer sleeps! That is all.';
    expect(run([PASSAGE], chunked(answer, 7)).text).toBe(`In short: ${ELISION}! That is all.`);
  });

  it('leaves runs shorter than the limit alone', () => {
    // 11 words from the passage, then it diverges.
    const answer = 'The quick brown fox jumps over the lazy dog while the cat ran.';
    expect(run([PASSAGE], [answer]).text).toBe(answer);
  });

  it('elides several separate runs, and the whole answer when it is all copied', () => {
    const second =
      'Cairns are piles of stones that hikers build to mark the trail across bare rock.';
    const answer = `${PASSAGE} Also, ${second}`;
    expect(run([PASSAGE, second], chunked(answer, 3)).text).toBe(`${ELISION}. Also, ${ELISION}.`);
    expect(run([PASSAGE], [PASSAGE]).text).toBe(`${ELISION}.`);
  });

  it('never sends a copied word, however the stream is split', () => {
    const answer = `Well, ${PASSAGE.slice(0, -1)} — or so they say.`;
    for (const size of [1, 2, 3, 5, 8, 13, 40, answer.length]) {
      const { sent, text } = run([PASSAGE], chunked(answer, size));
      expect(text).toBe(`Well, ${ELISION} — or so they say.`);
      expect(sent.join('')).not.toMatch(/quick|lazy|farmer|oak/);
    }
  });

  it('holds back the last words until they can no longer start a match', () => {
    const filter = new VerbatimFilter([PASSAGE], 12);
    // Fewer than 12 words: any of them could still start a copied run.
    expect(filter.push('Something else. The quick brown fox jumps')).toBe('');
    // 17 complete words: only the first 6 can no longer start or join a 12-word run.
    expect(filter.push(' high, said nobody at all ever again, and then stopped.')).toBe(
      'Something else. The quick brown fox',
    );
    expect(filter.flush()).toBe(' jumps high, said nobody at all ever again, and then stopped.');
  });

  it('drops [n] citations', () => {
    const answer = 'Foxes jump [1]. Dogs sleep [2, 3].';
    expect(run([PASSAGE], chunked(answer, 2)).text).toBe('Foxes jump. Dogs sleep.');
  });

  it('handles non-Latin scripts and combining marks', () => {
    const passage =
      'नमस्ते दुनिया यह एक परीक्षण वाक्य है जो बारह शब्दों से अधिक लंबा होना चाहिए ताकि';
    const answer = `उत्तर: ${passage}`;
    expect(run([passage], chunked(answer, 4)).text).toBe(`उत्तर: ${ELISION}`);
  });

  it('works with no passages', () => {
    expect(run([], ['Nothing ', 'to see.']).text).toBe('Nothing to see.');
  });
});
