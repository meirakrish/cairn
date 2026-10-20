import type { Embedder } from '@meirakrish/llm-kit';
import { and, asc, cosineDistance, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  chunks,
  sources,
  withUser,
  type ChunkLocation,
  type Db,
  type SourceKind,
  type Tx,
} from '../db';
import { keywordQuery } from './keywords';

export type SearchMode = 'hybrid' | 'vector' | 'keyword';

export interface SearchOptions {
  /** Chunks to return. */
  limit?: number;
  /** Candidates taken from each search before fusing. */
  candidates?: number;
  mode?: SearchMode;
  /** Prefix the question with Qwen3-Embedding's retrieval instruction (documents are embedded without). */
  queryInstruction?: boolean;
  signal?: AbortSignal;
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  filename: string;
  kind: SourceKind;
  ordinal: number;
  content: string;
  location: ChunkLocation;
  /** Reciprocal rank fusion score (higher is better). */
  score: number;
  /** 1-based rank in each search, or null if that search didn't return it. */
  vectorRank: number | null;
  keywordRank: number | null;
}

export const QUERY_INSTRUCTION =
  'Given a question, retrieve passages from the documents that answer it';

/** Qwen3-Embedding's query format; see its model card. */
export function embeddingQuery(question: string): string {
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${question}`;
}

// The usual reciprocal rank fusion constant: damps the advantage of the very top ranks.
const RRF_K = 60;

/**
 * Hybrid search over one cairn's chunks: nearest embeddings plus full-text matches, merged by
 * reciprocal rank fusion. Runs as the user, so RLS limits it to cairns they can see.
 */
export class RetrievalService {
  constructor(
    private db: Db,
    private embedder: Embedder,
  ) {}

  async search(
    userId: string,
    cairnId: string,
    question: string,
    opts: SearchOptions = {},
  ): Promise<RetrievedChunk[]> {
    const { limit = 8, candidates = 40, mode = 'hybrid', queryInstruction = true } = opts;
    const tsquery = mode === 'vector' ? undefined : keywordQuery(question);
    // Embed before opening the transaction: it can take a while and needs no database.
    const vector =
      mode === 'keyword'
        ? undefined
        : (
            await this.embedder.embed(
              [queryInstruction ? embeddingQuery(question) : question],
              opts,
            )
          )[0];

    return withUser(this.db, userId, async (tx) => {
      const vectorIds = vector ? await nearest(tx, cairnId, vector, candidates) : [];
      const keywordIds = tsquery ? await matching(tx, cairnId, tsquery, candidates) : [];

      const fused = new Map<
        string,
        { score: number; vectorRank: number | null; keywordRank: number | null }
      >();
      const add = (ids: string[], key: 'vectorRank' | 'keywordRank') =>
        ids.forEach((id, i) => {
          const hit = fused.get(id) ?? { score: 0, vectorRank: null, keywordRank: null };
          hit.score += 1 / (RRF_K + i + 1);
          hit[key] = i + 1;
          fused.set(id, hit);
        });
      add(vectorIds, 'vectorRank');
      add(keywordIds, 'keywordRank');

      const top = [...fused.entries()]
        .sort(
          ([, a], [, b]) =>
            b.score - a.score || (a.vectorRank ?? Infinity) - (b.vectorRank ?? Infinity),
        )
        .slice(0, limit);
      if (top.length === 0) return [];

      const rows = await tx
        .select({
          id: chunks.id,
          sourceId: chunks.sourceId,
          filename: sources.filename,
          kind: sources.kind,
          ordinal: chunks.ordinal,
          content: chunks.content,
          location: chunks.location,
        })
        .from(chunks)
        .innerJoin(sources, eq(sources.id, chunks.sourceId))
        .where(
          inArray(
            chunks.id,
            top.map(([id]) => id),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return top.flatMap(([id, hit]) => {
        const row = byId.get(id);
        return row ? [{ ...row, ...hit }] : [];
      });
    });
  }
}

/** Chunk ids nearest to `vector` (cosine), best first. */
async function nearest(
  tx: Tx,
  cairnId: string,
  vector: number[],
  limit: number,
): Promise<string[]> {
  // With a filter (the cairn, plus RLS), a plain HNSW scan can return fewer rows than asked for; an
  // iterative scan keeps searching. relaxed_order may return rows slightly out of order, so re-sort.
  await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
  await tx.execute(sql.raw(`set local hnsw.ef_search = ${Math.max(100, Math.trunc(limit))}`));
  const distance = cosineDistance(chunks.embedding, vector);
  const rows = await tx
    .select({ id: chunks.id, distance })
    .from(chunks)
    .where(eq(chunks.cairnId, cairnId))
    .orderBy(asc(distance))
    .limit(limit);
  return rows.sort((a, b) => Number(a.distance) - Number(b.distance)).map((r) => r.id);
}

/** Chunk ids matching any keyword, best first (ts_rank_cd). */
async function matching(
  tx: Tx,
  cairnId: string,
  tsquery: string,
  limit: number,
): Promise<string[]> {
  const query = sql`to_tsquery('simple', ${tsquery})`;
  const rank = sql<number>`ts_rank_cd(${chunks.tsv}, ${query})`;
  const rows = await tx
    .select({ id: chunks.id })
    .from(chunks)
    .where(and(eq(chunks.cairnId, cairnId), sql`${chunks.tsv} @@ ${query}`))
    .orderBy(desc(rank), asc(chunks.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
