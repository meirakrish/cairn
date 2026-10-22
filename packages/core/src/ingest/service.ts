import type { Embedder, LlmClient } from '@meirakrish/llm-kit';
import { isContextOverflow, ContextOverflowError } from '@meirakrish/llm-kit';
import type { CairnService } from '../cairns';
import { NotFoundError } from '../errors';
import type { Source } from '../db';
import { rejectedReason, type ModerationCategory, type Moderator } from '../moderation';
import type { SourceService } from '../sources';
import type { ObjectStore } from '../storage';
import type { FetchedPage } from '../web';
import { chunkSegments, DEFAULT_CHUNKING, type ChunkOptions } from './chunk';
import { detectFetchedKind, fetchedName } from './detect';
import { PermanentIngestError } from './errors';
import { extract, type Segment } from './extract';
import { readHtml } from './html';
import { describeImage, transcribePage } from './image';
import { readTable } from './table';

export interface IngestDeps {
  cairns: CairnService;
  sources: SourceService;
  storage: ObjectStore;
  embedder: Embedder;
  /** Reads images and scanned PDF pages; without it, images fail and scanned pages are skipped. */
  vision?: LlmClient;
  /** Fetches web sources (fetchUrl with the size cap); without it, web sources fail. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** Checks the extracted text before it is embedded; without it, nothing is checked. */
  moderator?: Moderator;
  chunking?: ChunkOptions;
}

export type IngestResult =
  | { status: 'ready'; chunks: number }
  | { status: 'rejected'; category: ModerationCategory }
  | { status: 'skipped'; reason: 'gone' | 'already ready' };

/**
 * Turns one stored source into embedded chunks: extract → chunk → embed → store, as the uploader.
 * Throws PermanentIngestError for problems with the file itself; anything else may be retried.
 */
export class IngestService {
  constructor(private deps: IngestDeps) {}

  async process(userId: string, sourceId: string): Promise<IngestResult> {
    const { cairns, sources, embedder } = this.deps;
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

    const {
      kind,
      mime,
      data,
      segments: read,
    } = source.url
      ? await this.fetchSource(userId, source, source.url)
      : { ...source, data: await this.load(source), segments: undefined };

    const chunking = this.deps.chunking ?? DEFAULT_CHUNKING;
    const segments =
      read ??
      (kind === 'image'
        ? await this.readImage(data)
        : await extract(kind, data, {
            maxChars: chunking.maxChars,
            readScannedPage: this.deps.vision && ((png) => transcribePage(this.deps.vision!, png)),
            contentType: mime,
          }));
    const chunks = chunkSegments(segments, chunking);
    if (chunks.length === 0) throw new PermanentIngestError('no text found in the file');

    // Image and scan descriptions are text by now, so they are checked like everything else.
    const verdict = await this.deps.moderator?.check(segments.map((s) => s.text).join('\n\n'));
    if (verdict && !verdict.allowed) {
      await this.deps.storage.delete(source.storageKey);
      await sources.reject(userId, sourceId, rejectedReason(verdict.category));
      return { status: 'rejected', category: verdict.category };
    }

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
        readTable(kind, data),
      );
    } catch (err) {
      // Deleted while we worked: nothing left to store into.
      if (err instanceof NotFoundError) return { status: 'skipped', reason: 'gone' };
      throw err;
    }
    return { status: 'ready', chunks: chunks.length };
  }

  private async load(source: Source): Promise<Uint8Array> {
    try {
      return await this.deps.storage.get(source.storageKey);
    } catch (err) {
      if (err instanceof NotFoundError)
        throw new PermanentIngestError('the uploaded file is missing');
      throw err;
    }
  }

  /**
   * Fetches a web source and keeps the snapshot under its storage key. Records what was fetched (kind,
   * title, type, size) before reading it, so a failed read still shows what the URL served. HTML is
   * read here, since the title comes with its text; other kinds are read like uploads.
   */
  private async fetchSource(userId: string, source: Source, url: string) {
    if (!this.deps.fetchPage) {
      throw new PermanentIngestError('this worker cannot fetch web pages');
    }
    const page = await this.deps.fetchPage(url);
    const detected = detectFetchedKind(page.contentType, page.url, page.data);
    if (!detected) {
      const type = page.contentType.split(';')[0]!.trim() || 'no type given';
      throw new PermanentIngestError(`the URL serves a file Cairn can't read (${type})`);
    }

    let html: ReturnType<typeof readHtml> | undefined;
    let readError: unknown;
    if (detected.kind === 'web') {
      try {
        html = readHtml(page.data, detected.mime);
      } catch (err) {
        readError = err;
      }
    }
    await this.deps.storage.put(source.storageKey, page.data, detected.mime);
    await this.deps.sources.recordFetch(userId, source.id, {
      ...detected,
      filename: fetchedName(page.url, html?.title),
      size: page.data.length,
    });
    if (readError) throw readError;
    return { ...detected, data: page.data, segments: html?.segments };
  }

  private async readImage(data: Uint8Array): Promise<Segment[]> {
    if (!this.deps.vision) {
      throw new PermanentIngestError('images need a vision model, and the worker has none');
    }
    return [{ text: await describeImage(this.deps.vision, data), location: {} }];
  }
}
