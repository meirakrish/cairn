import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  type CairnService,
  type QuizService,
} from '@cairn/core';
import {
  QuizAnswerRequest,
  type QuizQuestionResponse,
  type QuizResultResponse,
} from '@cairn/shared';
import { describeLlmError } from '@meirakrish/llm-kit';
import { Router, type Response } from 'express';
import type { Redis } from 'ioredis';
import { requireUser } from './auth/middleware';
import { idParam, requireAccess, requireCited } from './cairns';
import type { Config } from './config';
import { HttpError } from './errors';
import { limitQuestions } from './rate-limit';

export interface QuizRouterDeps {
  config: Config;
  cairns: CairnService;
  quiz: QuizService;
  redis: Redis;
}

/**
 * POST /api/cairns/:id/quiz: the next multiple-choice question (from the cairn's bank, or newly
 * written), then writes the following ones ahead in the background (QUIZ_PREFETCH).
 * POST /api/cairns/:id/quiz/:questionId/answer { choice }: the verdict and the passage; questionId
 * is the id the first route returned (the attempt).
 * Only for callers who can see sources. Asking for a question counts as a question against the Ask
 * rate limits; answering needs no model and doesn't.
 */
export function quizRouter({ config, cairns, quiz, redis }: QuizRouterDeps) {
  const router = Router();

  router.post('/:id/quiz', requireUser, async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const access = await requireAccess(cairns, userId, cairnId);
    requireCited(access);
    await limitQuestions(redis, config, userId, access, res);

    const question = await modelCall('write a question', res, (signal) =>
      quiz.next(userId, cairnId, { signal }),
    );
    const body: QuizQuestionResponse = { question };
    res.status(201).json(body);

    // Write the next questions while this one is answered, so Next doesn't wait for the model.
    if (config.quizPrefetch > 0) {
      quiz.prepare(userId, cairnId, config.quizPrefetch).catch((err: unknown) => {
        console.warn(`quiz: could not write ahead for cairn ${cairnId}: ${describeLlmError(err)}`);
      });
    }
  });

  router.post('/:id/quiz/:questionId/answer', requireUser, async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const questionId = idParam(req, 'questionId', 'question');
    const { choice } = QuizAnswerRequest.parse(req.body);
    requireCited(await requireAccess(cairns, userId, cairnId));

    const result = await quiz.answer(userId, cairnId, questionId, choice);
    const body: QuizResultResponse = { result };
    res.json(body);
  });

  return router;
}

const coreErrors = [NotFoundError, ForbiddenError, ConflictError, InvalidInputError];

/** Runs a call that may reach the model; a closed connection cancels it, a model failure is a 502. */
async function modelCall<T>(
  what: string,
  res: Response,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  try {
    return await call(controller.signal);
  } catch (err) {
    if (coreErrors.some((E) => err instanceof E)) throw err;
    console.error(`quiz: could not ${what}:`, err);
    // The model's own failure is worth naming (timed out, unreachable), as on Ask.
    throw new HttpError(502, `Could not ${what}: ${describeLlmError(err)}`);
  } finally {
    res.off('close', onClose);
  }
}
