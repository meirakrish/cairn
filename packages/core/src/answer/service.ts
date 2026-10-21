import type { AnswerEvent, CitedPassage } from '@cairn/shared';
import type { LlmClient } from '@meirakrish/llm-kit';
import { queryLog, withUser, type Db } from '../db';
import { ForbiddenError, NotFoundError } from '../errors';
import type { RetrievalService } from '../retrieval';
import { cairnAccess } from '../shares';
import { buildMessages, citedNumbers, type PromptOptions } from './prompt';

export interface AnswerOptions extends PromptOptions {
  signal?: AbortSignal;
}

export const NOTHING_FOUND = "I couldn't find anything about that in this cairn's documents.";

/**
 * Answers a question about one cairn: retrieve passages, stream the model's answer, report citations.
 * Runs as the user (RLS): a cairn they can't see is a NotFoundError. Logs the question to query_log,
 * with the share it came through, when the answer completes.
 */
export class AnswerService {
  constructor(
    private db: Db,
    private retrieval: RetrievalService,
    private llm: LlmClient,
  ) {}

  async *answer(
    userId: string,
    cairnId: string,
    question: string,
    opts: AnswerOptions = {},
  ): AsyncGenerator<AnswerEvent> {
    const started = Date.now();
    const access = await withUser(this.db, userId, (tx) => cairnAccess(tx, cairnId));
    if (!access) throw new NotFoundError('cairn');
    // Sealed answers (no passages, no citations) come in Phase 4 step 4; until then, refuse.
    if (access.visibility === 'sealed') throw new ForbiddenError('sealed answers are not ready');
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
      for await (const piece of this.llm.stream(buildMessages(question, chunks, opts), {
        signal: opts.signal,
      })) {
        text += piece;
        yield { type: 'delta', text: piece };
      }
    }

    const latencyMs = Date.now() - started;
    await withUser(this.db, userId, (tx) =>
      tx.insert(queryLog).values({
        cairnId,
        userId,
        shareId: access.shareId,
        question,
        chunkCount: chunks.length,
        latencyMs,
      }),
    );
    yield { type: 'done', cited: citedNumbers(text, passages.length), latencyMs };
  }
}
