/** A run of this many words copied from a passage is replaced in sealed answers. */
export const VERBATIM_WORDS = 12;

export const ELISION = '…';

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
// [1], [1, 2], with the space before it: citations mean nothing to a reader without sources.
const CITATION = /\s*\[\d+(?:\s*,\s*\d+)*\]/g;

interface Word {
  key: string;
  start: number;
  end: number;
}

function words(text: string): Word[] {
  return [...text.matchAll(WORD)].map((m) => ({
    key: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Sealed mode's backstop for "don't quote": streams an answer through, replacing every run of
 * `n` or more words that appears verbatim in a passage (case and punctuation ignored) with "…",
 * and dropping [n] citations. The last words are held back until they can no longer start or
 * extend a match, so nothing copied is ever sent; `flush()` releases the rest at the end.
 */
export class VerbatimFilter {
  private ngrams = new Set<string>();
  private text = '';
  private sent = 0;

  constructor(
    passages: string[],
    private n = VERBATIM_WORDS,
  ) {
    for (const passage of passages) {
      const keys = words(passage).map((w) => w.key);
      for (let i = 0; i + n <= keys.length; i++) this.ngrams.add(keys.slice(i, i + n).join(' '));
    }
  }

  /** Adds a piece of the answer; returns the text that is now safe to send (maybe ""). */
  push(piece: string): string {
    this.text += piece;
    return this.release(false);
  }

  /** The answer is complete: returns everything not sent yet. */
  flush(): string {
    return this.release(true);
  }

  private release(final: boolean): string {
    const text = this.text.replace(CITATION, '');
    const all = words(text);
    // The last word may still be growing ("hel" + "lo"), unless the text ends after it.
    const complete = final || all.at(-1)?.end !== text.length ? all.length : all.length - 1;
    const covered = new Array<boolean>(all.length).fill(false);
    for (let i = 0; i + this.n <= complete; i++) {
      const key = all
        .slice(i, i + this.n)
        .map((w) => w.key)
        .join(' ');
      if (this.ngrams.has(key)) covered.fill(true, i, i + this.n);
    }

    // Words from `held` on could still be covered by a run that isn't complete yet; and a covered
    // run touching them could still grow, so hold that back too (it becomes one "…").
    let held = final ? all.length : Math.max(0, complete - this.n + 1);
    while (held > 0 && covered[held - 1] && !final) held--;
    const end = final ? text.length : held === 0 ? 0 : all[held - 1]!.end;

    let out = '';
    let at = 0;
    for (let i = 0; i < held; i++) {
      if (!covered[i]) continue;
      let j = i;
      while (j + 1 < held && covered[j + 1]) j++;
      out += text.slice(at, all[i]!.start) + ELISION;
      at = all[j]!.end;
      i = j;
    }
    out += text.slice(at, end);

    // Everything up to `end` is final, so `out` only ever grows; send the new part.
    const fresh = out.slice(this.sent);
    this.sent = out.length;
    return fresh;
  }
}
