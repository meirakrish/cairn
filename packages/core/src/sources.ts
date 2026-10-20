import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  cairns,
  chunks,
  sources,
  withUser,
  type ChunkLocation,
  type Db,
  type Source,
  type SourceKind,
} from './db';
import { NotFoundError } from './errors';

export interface CreateSourceInput {
  kind: SourceKind;
  filename: string;
  mime: string;
  size: number;
}

export interface ChunkInput {
  content: string;
  location: ChunkLocation;
  embedding: number[];
}

const MAX_ERROR_LENGTH = 500;
const INSERT_BATCH = 200;

export function storageKey(cairnId: string, sourceId: string): string {
  return `cairns/${cairnId}/sources/${sourceId}`;
}

// Like CairnService, every query runs as a user, so RLS decides what is visible.
// The worker calls the processing methods as the user who uploaded the source.
export class SourceService {
  constructor(private db: Db) {}

  /** Records a new pending source. The id is chosen here so the storage key is known before upload. */
  async create(userId: string, cairnId: string, input: CreateSourceInput): Promise<Source> {
    return withUser(this.db, userId, async (tx) => {
      const [cairn] = await tx.select({ id: cairns.id }).from(cairns).where(eq(cairns.id, cairnId));
      if (!cairn) throw new NotFoundError('cairn');
      const id = randomUUID();
      const [source] = await tx
        .insert(sources)
        .values({ id, cairnId, ...input, storageKey: storageKey(cairnId, id), createdBy: userId })
        .returning();
      return source!;
    });
  }

  async list(userId: string, cairnId: string): Promise<Source[]> {
    return withUser(this.db, userId, (tx) =>
      tx
        .select()
        .from(sources)
        .where(eq(sources.cairnId, cairnId))
        .orderBy(desc(sources.createdAt)),
    );
  }

  async get(userId: string, sourceId: string): Promise<Source | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId));
      return source;
    });
  }

  /** Deletes the source and its chunks; returns the row so the caller can delete the stored file. */
  async delete(userId: string, sourceId: string): Promise<Source | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx.delete(sources).where(eq(sources.id, sourceId)).returning();
      return source;
    });
  }

  /**
   * Claims a source for processing. Returns undefined if it is gone or already ready,
   * so a duplicate or late job does nothing.
   */
  async markProcessing(userId: string, sourceId: string): Promise<Source | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .update(sources)
        .set({ status: 'processing', error: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(sources.id, sourceId),
            inArray(sources.status, ['pending', 'processing', 'failed']),
          ),
        )
        .returning();
      return source;
    });
  }

  /** Replaces the source's chunks and marks it ready, in one transaction. */
  async complete(userId: string, sourceId: string, input: ChunkInput[]): Promise<Source> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId));
      if (!source) throw new NotFoundError('source');

      await tx.delete(chunks).where(eq(chunks.sourceId, sourceId));
      for (let i = 0; i < input.length; i += INSERT_BATCH) {
        await tx.insert(chunks).values(
          input.slice(i, i + INSERT_BATCH).map((c, j) => ({
            cairnId: source.cairnId,
            sourceId,
            ordinal: i + j,
            ...c,
          })),
        );
      }
      const [ready] = await tx
        .update(sources)
        .set({ status: 'ready', error: null, updatedAt: sql`now()` })
        .where(eq(sources.id, sourceId))
        .returning();
      return ready!;
    });
  }

  /** Marks the source failed with a short, user-facing reason. */
  async fail(userId: string, sourceId: string, error: string): Promise<Source | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .update(sources)
        .set({ status: 'failed', error: error.slice(0, MAX_ERROR_LENGTH), updatedAt: sql`now()` })
        .where(eq(sources.id, sourceId))
        .returning();
      return source;
    });
  }

  async listChunks(userId: string, sourceId: string) {
    return withUser(this.db, userId, (tx) =>
      tx
        .select({
          id: chunks.id,
          ordinal: chunks.ordinal,
          content: chunks.content,
          location: chunks.location,
        })
        .from(chunks)
        .where(eq(chunks.sourceId, sourceId))
        .orderBy(asc(chunks.ordinal)),
    );
  }
}
