import type { AnswerService, CairnService, Moderator } from '@cairn/core';
import { QueryRequest, type AnswerEvent, type SealedAnswerEvent } from '@cairn/shared';
import { describeLlmError } from '@meirakrish/llm-kit';
import { Router } from 'express';
import type { Redis } from 'ioredis';
import { requireUser } from './auth/middleware';
import { idParam, requireAccess } from './cairns';
import type { Config } from './config';
import { checkText } from './moderation';
import { limitQuestions } from './rate-limit';

export interface QueryRouterDeps {
  config: Config;
  cairns: CairnService;
  answers: AnswerService;
  redis: Redis;
  moderator: Moderator;
}

/**
 * POST /api/cairns/:id/query { question }: the answer as a Server-Sent Events stream of AnswerEvents
 * (passages, text deltas, done), or for sealed callers SealedAnswerEvents (text deltas, done). Validation, access and rate limits are checked before the stream
 * starts, so they still get plain JSON errors. Closing the connection cancels the model call.
 * Rate limits: per user, and for share callers also per share (a link can reach many people).
 * The question is moderated after the limits (each check is a model call): blocked → 422.
 */
export function queryRouter({ config, cairns, answers, redis, moderator }: QueryRouterDeps) {
  const router = Router();

  router.post('/:id/query', requireUser, async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const { question } = QueryRequest.parse(req.body);
    const access = await requireAccess(cairns, userId, cairnId);

    await limitQuestions(redis, config, userId, access, res);

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    await checkText(moderator, question, controller.signal);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: AnswerEvent | SealedAnswerEvent) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);

    const opts = { signal: controller.signal };
    const events =
      access.visibility === 'sealed'
        ? answers.answerSealed(userId, cairnId, question, opts)
        : answers.answer(userId, cairnId, question, opts);
    try {
      for await (const event of events) send(event);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`query on cairn ${cairnId} failed:`, err);
        // The model's own failure is worth naming (timed out, unreachable); internals are not.
        send({ type: 'error', message: `Could not answer: ${describeLlmError(err)}` });
      }
    }
    res.end();
  });

  return router;
}
