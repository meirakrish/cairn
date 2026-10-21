import type { AnswerEvent, CitedPassage, SealedAnswerEvent } from '@cairn/shared';
import type { LlmClient } from '@meirakrish/llm-kit';
import { queryLog, withUser, type Db } from '../db';
import { ForbiddenError, NotFoundError } from '../errors';
import type { RetrievalService } from '../retrieval';
import { cairnAccess, type CairnAccess } from '../shares';
import { buildMessages, citedNumbers } from './prompt';
import { VerbatimFilter } from './verbatim';

export interface AnswerOptions {
  signal?: AbortSignal;
}

export const NOTHING_FOUND = "I couldn't find anything about that in this cairn's documents.";

/**
 * Answers a question about one cairn: retrieve passages, stream the model's answer. Runs as the user
 * (RLS): a cairn they can't see is a NotFoundError. Logs the question to query_log, with the share
 * it came through, when the answer completes.
 *
 * Two entry points with different event types, so a sealed caller's stream has nowhere to carry
 * sources: answer() (passages, citations) refuses sealed callers; answerSealed() serves anyone.
 */
export class AnswerService {
  constructor(
    private db: Db,
    private retrieval: RetrievalService,
    private llm: LlmClient,
  ) {}

  /** Cited answer: the passages, the text, then which passages it cited. */
  async *answer(
    userId: string,
    cairnId: string,
    question: string,
    opts: AnswerOptions = {},
  ): AsyncGenerator<AnswerEvent> {
    const started = Date.now();
    const access = await this.access(userId, cairnId);
    if (access.visibility === 'sealed') {
      throw new ForbiddenError('sources are not shown for this cairn');
    }
    const chunks = await this.retrieval.search(userId, cairnId, question, { signal: opts.signal });
    const passages: CitedPassage[] = chunks.map((c, i) => ({
      n: i + 1,
      sourceId: c.sourceId,
      filename: c.filename,
      kind: c.kind,
      location: c.location,
      text: c.content,
    }));
    yield { type: 'passages', passages };

    let text = '';
    if (chunks.length === 0) {
      // Nothing indexed (or nothing matched): no point asking the model to answer from nothing.
      text = NOTHING_FOUND;
      yield { type: 'delta', text };
    } else {
      for await (const piece of this.llm.stream(buildMessages(question, chunks), {
        signal: opts.signal,
      })) {
        text += piece;
        yield { type: 'delta', text: piece };
      }
    }

    const latencyMs = await this.log(userId, cairnId, access, question, chunks.length, started);
    yield { type: 'done', cited: citedNumbers(text, passages.length), latencyMs };
  }

  /**
   * Sealed answer: text only. The prompt has no file names or locations and asks for no quoting;
   * the text is streamed through a VerbatimFilter, so copied runs become "…".
   */
  async *answerSealed(
    userId: string,
    cairnId: string,
    question: string,
    opts: AnswerOptions = {},
  ): AsyncGenerator<SealedAnswerEvent> {
    const started = Date.now();
    const access = await this.access(userId, cairnId);
    const chunks = await this.retrieval.search(userId, cairnId, question, { signal: opts.signal });

    if (chunks.length === 0) {
      yield { type: 'delta', text: NOTHING_FOUND };
    } else {
      const filter = new VerbatimFilter(chunks.map((c) => c.content));
      for await (const piece of this.llm.stream(buildMessages(question, chunks, { sealed: true }), {
        signal: opts.signal,
      })) {
        const text = filter.push(piece);
        if (text) yield { type: 'delta', text };
      }
      const rest = filter.flush();
      if (rest) yield { type: 'delta', text: rest };
    }

    const latencyMs = await this.log(userId, cairnId, access, question, chunks.length, started);
    yield { type: 'done', latencyMs };
  }

  private async access(userId: string, cairnId: string): Promise<CairnAccess> {
    const access = await withUser(this.db, userId, (tx) => cairnAccess(tx, cairnId));
    if (!access) throw new NotFoundError('cairn');
    return access;
  }

  private async log(
    userId: string,
    cairnId: string,
    access: CairnAccess,
    question: string,
    chunkCount: number,
    started: number,
  ): Promise<number> {
    const latencyMs = Date.now() - started;
    await withUser(this.db, userId, (tx) =>
      tx.insert(queryLog).values({
        cairnId,
        userId,
        shareId: access.shareId,
        question,
        chunkCount,
        latencyMs,
      }),
    );
    return latencyMs;
  }
}
