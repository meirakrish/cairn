import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
import type { SourceChange, SourceChangeListener } from './events';

export interface CreateSourceInput {
  kind: SourceKind;
  filename: string;
  mime: string;
  size: number;
  /** For web sources: the page to fetch (normalised by checkWebUrl). */
  url?: string;
}

/** What the worker learns from fetching a web source. */
export interface FetchedSourceInput {
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
export interface SourceServiceOptions {
  /**
   * Told about every committed change (create, status changes, delete), e.g. to publish live updates.
   * Its errors are logged, never thrown: the change itself already happened.
   */
  onChange?: SourceChangeListener;
}

export class SourceService {
  constructor(
    private db: Db,
    private opts: SourceServiceOptions = {},
  ) {}

  private async notify(change: SourceChange): Promise<void> {
    try {
      await this.opts.onChange?.(change);
    } catch (err) {
      console.warn(`source ${change.source.id}: change listener failed:`, err);
    }
  }

  private async changed(source: Source | undefined): Promise<Source | undefined> {
    if (source) await this.notify({ kind: 'changed', source });
    return source;
  }

  /** Records a new pending source. The id is chosen here so the storage key is known before upload. */
  async create(userId: string, cairnId: string, input: CreateSourceInput): Promise<Source> {
    const source = await withUser(this.db, userId, async (tx) => {
      const [cairn] = await tx.select({ id: cairns.id }).from(cairns).where(eq(cairns.id, cairnId));
      if (!cairn) throw new NotFoundError('cairn');
      const id = randomUUID();
      const [source] = await tx
        .insert(sources)
        .values({ id, cairnId, ...input, storageKey: storageKey(cairnId, id), createdBy: userId })
        .returning();
      return source!;
    });
    await this.notify({ kind: 'changed', source });
    return source;
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

  /** The source fetched from this URL in the cairn, if any. */
  async findByUrl(userId: string, cairnId: string, url: string): Promise<Source | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.cairnId, cairnId), eq(sources.url, url)));
      return source;
    });
  }

  /** Records the kind, name, type and size of a fetched page (they change on every refresh). */
  async recordFetch(
    userId: string,
    sourceId: string,
    input: FetchedSourceInput,
  ): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .update(sources)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(sources.id, sourceId))
        .returning();
      return source;
    });
    return this.changed(source);
  }

  /**
   * Sets a web source back to pending so it is fetched again. Returns undefined unless it is a web
   * source that is ready or failed (one being fetched already has nothing to gain).
   */
  async requeue(userId: string, sourceId: string): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .update(sources)
        .set({ status: 'pending', error: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(sources.id, sourceId),
            isNotNull(sources.url),
            inArray(sources.status, ['ready', 'failed']),
          ),
        )
        .returning();
      return source;
    });
    return this.changed(source);
  }

  /** Deletes the source and its chunks; returns the row so the caller can delete the stored file. */
  async delete(userId: string, sourceId: string): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
      const [source] = await tx.delete(sources).where(eq(sources.id, sourceId)).returning();
      return source;
    });
    if (source) await this.notify({ kind: 'deleted', source });
    return source;
  }

  /**
   * Claims a source for processing. Returns undefined if it is gone or already ready,
   * so a duplicate or late job does nothing.
   */
  async markProcessing(userId: string, sourceId: string): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
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
    return this.changed(source);
  }

  /** Replaces the source's chunks and marks it ready, in one transaction. */
  async complete(userId: string, sourceId: string, input: ChunkInput[]): Promise<Source> {
    const ready = await withUser(this.db, userId, async (tx) => {
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
    await this.notify({ kind: 'changed', source: ready });
    return ready;
  }

  /** Marks the source failed with a short, user-facing reason. */
  async fail(userId: string, sourceId: string, error: string): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .update(sources)
        .set({ status: 'failed', error: error.slice(0, MAX_ERROR_LENGTH), updatedAt: sql`now()` })
        .where(eq(sources.id, sourceId))
        .returning();
      return source;
    });
    return this.changed(source);
  }

  /**
   * Marks the source rejected by moderation, with the reason, and drops any chunks. Final: unlike a
   * failed source it is never processed or refreshed again, only deleted.
   */
  async reject(userId: string, sourceId: string, reason: string): Promise<Source | undefined> {
    const source = await withUser(this.db, userId, async (tx) => {
      await tx.delete(chunks).where(eq(chunks.sourceId, sourceId));
      const [source] = await tx
        .update(sources)
        .set({
          status: 'rejected',
          error: reason.slice(0, MAX_ERROR_LENGTH),
          updatedAt: sql`now()`,
        })
        .where(eq(sources.id, sourceId))
        .returning();
      return source;
    });
    return this.changed(source);
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
