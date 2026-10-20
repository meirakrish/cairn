import { describe, expect, it } from 'vitest';
import { passageRank, questionRank, summarize, type Question } from './metrics';

const hits = [
  { filename: 'a.md', content: 'Nothing here.' },
  { filename: 'b.md', content: 'The  Filing\nDeadline is soon.' },
  { filename: 'a.md', content: 'The filing deadline is in a.' },
];

describe('passageRank', () => {
  it('matches by source and phrase, ignoring case and whitespace', () => {
    expect(passageRank(hits, { source: 'b.md', contains: 'filing deadline' })).toBe(2);
    expect(passageRank(hits, { source: 'a.md', contains: 'filing deadline' })).toBe(3);
    expect(passageRank(hits, { source: 'c.md', contains: 'filing deadline' })).toBe(Infinity);
  });
});

describe('questionRank', () => {
  const q = (any?: boolean): Question => ({
    id: 'q',
    style: 'direct',
    question: '?',
    any,
    expect: [
      { source: 'b.md', contains: 'deadline' },
      { source: 'a.md', contains: 'deadline' },
    ],
  });

  it('needs every passage by default, and one with any', () => {
    expect(questionRank(hits, q())).toBe(3);
    expect(questionRank(hits, q(true))).toBe(2);
  });
});

describe('summarize', () => {
  it('computes recall@k and MRR within the largest k', () => {
    const s = summarize([1, 2, 5, Infinity], [1, 3, 8]);
    expect(s.recall).toEqual({ 1: 0.25, 3: 0.5, 8: 0.75 });
    expect(s.mrr).toBeCloseTo((1 + 0.5 + 0.2 + 0) / 4);
  });
});
