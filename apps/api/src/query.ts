import type { AnswerService, CairnService } from '@cairn/core';
import { QueryRequest, type AnswerEvent } from '@cairn/shared';
import { describeLlmError } from '@meirakrish/llm-kit';
import { Router } from 'express';
import type { Redis } from 'ioredis';
import { requireUser } from './auth/middleware';
import { idParam, requireAccess } from './cairns';
import type { Config } from './config';
import { HttpError } from './errors';
import { rateLimit } from './rate-limit';

export interface QueryRouterDeps {
  config: Config;
  cairns: CairnService;
  answers: AnswerService;
  redis: Redis;
}

/**
 * POST /api/cairns/:id/query { question }: the answer as a Server-Sent Events stream of AnswerEvents
 * (passages, text deltas, done). Validation, access and rate limits are checked before the stream
 * starts, so they still get plain JSON errors. Closing the connection cancels the model call.
 * Rate limits: per user, and for share callers also per share (a link can reach many people).
 */
export function queryRouter({ config, cairns, answers, redis }: QueryRouterDeps) {
  const router = Router();

  router.post('/:id/query', requireUser, async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const { question } = QueryRequest.parse(req.body);
    const access = await requireAccess(cairns, userId, cairnId);
    // Sealed answers come in Phase 4 step 4; AnswerService refuses them too.
    if (access.visibility === 'sealed')
      throw new HttpError(403, 'sealed answers are not ready yet');

    const retryAfter =
      (await rateLimit(redis, `query:user:${userId}`, config.queryRateLimit, 60)) ||
      (access.shareId
        ? await rateLimit(redis, `query:share:${access.shareId}`, config.shareQueryRateLimit, 60)
        : 0);
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpError(429, `too many questions; try again in ${retryAfter} s`);
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: AnswerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      for await (const event of answers.answer(userId, cairnId, question, {
        signal: controller.signal,
      })) {
        send(event);
      }
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
