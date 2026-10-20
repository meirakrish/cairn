/** One passage a question should retrieve. */
export interface Expected {
  source: string;
  contains: string;
}

export interface Question {
  id: string;
  style: 'direct' | 'paraphrase' | 'exact';
  question: string;
  expect: Expected[];
  /** One expected passage is enough (default: all of them). */
  any?: boolean;
}

export interface Hit {
  filename: string;
  content: string;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** 1-based rank of the first hit holding the passage, or Infinity if none does. */
export function passageRank(hits: Hit[], expected: Expected): number {
  const needle = normalize(expected.contains);
  const i = hits.findIndex(
    (h) => h.filename === expected.source && normalize(h.content).includes(needle),
  );
  return i === -1 ? Infinity : i + 1;
}

/** The rank at which the question counts as answered: its best passage (any) or its worst (all). */
export function questionRank(hits: Hit[], q: Question): number {
  const ranks = q.expect.map((e) => passageRank(hits, e));
  return q.any ? Math.min(...ranks) : Math.max(...ranks);
}

export interface Summary {
  questions: number;
  /** Share of questions answered within the top k, per k. */
  recall: Record<number, number>;
  /** Mean reciprocal rank, counting only ranks within the largest k. */
  mrr: number;
}

export function summarize(ranks: number[], ks: number[]): Summary {
  const maxK = Math.max(...ks);
  const share = (k: number) => ranks.filter((r) => r <= k).length / ranks.length;
  return {
    questions: ranks.length,
    recall: Object.fromEntries(ks.map((k) => [k, share(k)])),
    mrr: ranks.reduce((sum, r) => sum + (r <= maxK ? 1 / r : 0), 0) / ranks.length,
  };
}
