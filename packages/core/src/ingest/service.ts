import type { Embedder, LlmClient } from '@meirakrish/llm-kit';
import { isContextOverflow, ContextOverflowError } from '@meirakrish/llm-kit';
import type { CairnService } from '../cairns';
import { NotFoundError } from '../errors';
import type { SourceService } from '../sources';
import type { ObjectStore } from '../storage';
import { chunkSegments, DEFAULT_CHUNKING, type ChunkOptions } from './chunk';
import { PermanentIngestError } from './errors';
import { extract, type Segment } from './extract';
import { describeImage } from './image';

export interface IngestDeps {
  cairns: CairnService;
  sources: SourceService;
  storage: ObjectStore;
  embedder: Embedder;
  /** Reads images (transcription + description); without it, image sources fail. */
  vision?: LlmClient;
  chunking?: ChunkOptions;
}

export type IngestResult =
  { status: 'ready'; chunks: number } | { status: 'skipped'; reason: 'gone' | 'already ready' };

/**
 * Turns one stored source into embedded chunks: extract → chunk → embed → store, as the uploader.
 * Throws PermanentIngestError for problems with the file itself; anything else may be retried.
 */
export class IngestService {
  constructor(private deps: IngestDeps) {}

  async process(userId: string, sourceId: string): Promise<IngestResult> {
    const { cairns, sources, storage, embedder } = this.deps;
    const source = await sources.markProcessing(userId, sourceId);
    if (!source) {
      const existing = await sources.get(userId, sourceId);
      return { status: 'skipped', reason: existing ? 'already ready' : 'gone' };
    }

    const cairn = await cairns.get(userId, source.cairnId);
    if (!cairn) return { status: 'skipped', reason: 'gone' };
    if (cairn.embedModel !== embedder.model) {
      throw new PermanentIngestError(
        `this cairn uses the embedding model ${cairn.embedModel}, but the worker runs ${embedder.model}`,
      );
    }

    let data: Uint8Array;
    try {
      data = await storage.get(source.storageKey);
    } catch (err) {
      if (err instanceof NotFoundError)
        throw new PermanentIngestError('the uploaded file is missing');
      throw err;
    }

    const chunking = this.deps.chunking ?? DEFAULT_CHUNKING;
    const segments =
      source.kind === 'image'
        ? await this.readImage(data)
        : await extract(source.kind, data, chunking.maxChars);
    const chunks = chunkSegments(segments, chunking);
    if (chunks.length === 0) throw new PermanentIngestError('no text found in the file');

    let vectors: number[][];
    try {
      vectors = await embedder.embed(chunks.map((c) => c.content));
    } catch (err) {
      if (err instanceof ContextOverflowError || isContextOverflow(err)) {
        throw new PermanentIngestError('a part of the file is too long for the embedding model');
      }
      throw err;
    }

    try {
      await sources.complete(
        userId,
        sourceId,
        chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })),
      );
    } catch (err) {
      // Deleted while we worked: nothing left to store into.
      if (err instanceof NotFoundError) return { status: 'skipped', reason: 'gone' };
      throw err;
    }
    return { status: 'ready', chunks: chunks.length };
  }

  private async readImage(data: Uint8Array): Promise<Segment[]> {
    if (!this.deps.vision) {
      throw new PermanentIngestError('images need a vision model, and the worker has none');
    }
    return [{ text: await describeImage(this.deps.vision, data), location: {} }];
  }
}
