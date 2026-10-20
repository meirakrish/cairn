import type { Embedder } from '@meirakrish/llm-kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { EMBEDDING_DIMENSIONS } from '../db';
import { SourceService } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import { keywordQuery } from './keywords';
import { embeddingQuery, RetrievalService } from './service';

const { admin, app } = createTestDbs();
const cairns = new CairnService(app.db, 'bow');
const sources = new SourceService(app.db);

/**
 * Bag-of-words vectors: texts that share words point the same way, so "semantic" ranking is
 * predictable without a model. Strips the query instruction so it doesn't add shared words.
 */
function bagOfWords(): Embedder & { seen: string[] } {
  const seen: string[] = [];
  const embedOne = (text: string) => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const body = text.replace(/^Instruct: .*\nQuery:/s, '');
    for (const [w] of body.toLowerCase().matchAll(/[a-z0-9]+/g)) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % EMBEDDING_DIMENSIONS]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    provider: 'custom',
    model: 'bow',
    dimensions: EMBEDDING_DIMENSIONS,
    seen,
    async embed(texts) {
      seen.push(...texts);
      return texts.map(embedOne);
    },
  };
}

let embedder: ReturnType<typeof bagOfWords>;
let retrieval: RetrievalService;

beforeEach(async () => {
  await resetDb(admin.db);
  embedder = bagOfWords();
  retrieval = new RetrievalService(app.db, embedder);
});
afterAll(async () => {
  await admin.close();
  await app.close();
});

/** A cairn with one ready source holding `texts` as chunks. */
async function cairnWith(texts: string[], owner?: { id: string }) {
  const user = owner ?? (await createUser(admin.db));
  const cairn = await cairns.create(user.id, { name: 'C' });
  const source = await sources.create(user.id, cairn.id, {
    kind: 'text',
    filename: 'notes.txt',
    mime: 'text/plain',
    size: 1,
  });
  const vectors = await embedder.embed(texts);
  await sources.complete(
    user.id,
    source.id,
    texts.map((content, i) => ({ content, location: { offset: i }, embedding: vectors[i]! })),
  );
  embedder.seen.length = 0;
  return { user, cairn, source };
}

const DOCS = [
  'Cairns are stacks of stones that mark hiking trails above the tree line.',
  'The filing deadline for the quarterly report is the fifteenth of the month.',
  'Garage stores uploaded originals; the access key starts with GK0042.',
  'Bread needs flour, water, salt and yeast, and an hour to rise.',
];

describe('RetrievalService.search', () => {
  it('ranks the passage that answers the question first, with source details', async () => {
    const { user, cairn, source } = await cairnWith(DOCS);

    const [best] = await retrieval.search(
      user.id,
      cairn.id,
      'When is the quarterly report filing deadline?',
    );
    expect(best).toMatchObject({
      sourceId: source.id,
      filename: 'notes.txt',
      kind: 'text',
      ordinal: 1,
      location: { offset: 1 },
      vectorRank: 1,
      keywordRank: 1,
    });
    expect(best!.content).toMatch(/filing deadline/);
  });

  it('embeds the question with the retrieval instruction, unless turned off', async () => {
    const { user, cairn } = await cairnWith(DOCS);

    await retrieval.search(user.id, cairn.id, 'trail markers');
    await retrieval.search(user.id, cairn.id, 'trail markers', { queryInstruction: false });
    expect(embedder.seen).toEqual([embeddingQuery('trail markers'), 'trail markers']);
  });

  it('finds exact identifiers by keyword', async () => {
    const { user, cairn } = await cairnWith(DOCS);

    const hits = await retrieval.search(user.id, cairn.id, 'gk0042', { mode: 'keyword' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ordinal: 2, keywordRank: 1, vectorRank: null });
    expect(embedder.seen).toEqual([]); // keyword mode needs no embedding
  });

  it('vector mode ignores keywords; hybrid keeps hits found by only one search', async () => {
    const { user, cairn } = await cairnWith(DOCS);

    const vector = await retrieval.search(user.id, cairn.id, 'stones trails', {
      mode: 'vector',
      limit: 2,
    });
    expect(vector.every((h) => h.keywordRank === null)).toBe(true);
    expect(vector[0]?.ordinal).toBe(0);

    // "yeast" matches one chunk by keyword; every chunk has some vector rank.
    const hybrid = await retrieval.search(user.id, cairn.id, 'yeast', { limit: 4 });
    expect(hybrid[0]).toMatchObject({ ordinal: 3, keywordRank: 1 });
    expect(hybrid.filter((h) => h.keywordRank === null)).toHaveLength(3);
  });

  it('still answers questions made only of common words, by vector', async () => {
    const { user, cairn } = await cairnWith(DOCS);

    const hits = await retrieval.search(user.id, cairn.id, 'what is it about?', { limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.keywordRank === null)).toBe(true);
  });

  it('only searches the given cairn, and only as someone who can see it', async () => {
    const alice = await cairnWith(DOCS);
    const bobsCairn = await cairnWith(['Bob also writes about the filing deadline.']);
    const other = await createUser(admin.db);

    const hits = await retrieval.search(alice.user.id, alice.cairn.id, 'filing deadline', {
      limit: 10,
    });
    expect(hits.map((h) => h.content)).not.toContain('Bob also writes about the filing deadline.');
    expect(await retrieval.search(other.id, alice.cairn.id, 'filing deadline')).toEqual([]);
    // Bob can't reach Alice's cairn by id either.
    expect(await retrieval.search(bobsCairn.user.id, alice.cairn.id, 'filing deadline')).toEqual(
      [],
    );
  });

  it("returns the cairn's chunks even when another cairn has many closer ones", async () => {
    const owner = await createUser(admin.db);
    // 300 near-duplicates of the question in one cairn, 3 loosely related chunks in the other.
    await cairnWith(
      Array.from({ length: 300 }, (_, i) => `report deadline filing quarterly copy ${i}`),
      owner,
    );
    const small = await cairnWith(
      ['The report is late.', 'Deadlines matter.', 'Quarterly numbers are in.'],
      owner,
    );

    const hits = await retrieval.search(
      owner.id,
      small.cairn.id,
      'quarterly report filing deadline',
      {
        mode: 'vector',
      },
    );
    expect(hits).toHaveLength(3);
  });

  it('returns nothing for an empty cairn', async () => {
    const user = await createUser(admin.db);
    const cairn = await cairns.create(user.id, { name: 'Empty' });
    expect(await retrieval.search(user.id, cairn.id, 'anything')).toEqual([]);
  });
});

describe('keywordQuery', () => {
  it('keeps meaningful words, lowercased and deduplicated, joined with OR', () => {
    expect(keywordQuery('When is the Filing deadline? The FILING deadline!')).toBe(
      'filing | deadline',
    );
  });

  it('drops punctuation that would break to_tsquery', () => {
    expect(keywordQuery("o'brien & co | (draft) !x:*")).toBe('brien | co | draft');
  });

  it('returns undefined when only common words remain', () => {
    expect(keywordQuery('What is it about?')).toBeUndefined();
    expect(keywordQuery('   ')).toBeUndefined();
  });
});
