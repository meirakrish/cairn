import { BlockedContentError, type Moderator } from '@cairn/core';
import { describeLlmError } from '@meirakrish/llm-kit';
import { HttpError } from './errors';

/**
 * Throws a 422 when the moderator blocks `text`, and a 503 when it can't say (model down): text is
 * never let through unchecked.
 */
export async function checkText(moderator: Moderator, text: string, signal?: AbortSignal) {
  let verdict;
  try {
    verdict = await moderator.check(text, { signal });
  } catch (err) {
    console.error('moderation failed:', err);
    throw new HttpError(503, `Could not check the text: ${describeLlmError(err)}`);
  }
  if (!verdict.allowed) throw new HttpError(422, new BlockedContentError(verdict.category).message);
}
