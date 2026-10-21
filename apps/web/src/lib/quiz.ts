import type { QuizVerdict } from '@cairn/shared';

/** How a quiz question ended: a verdict, or skipped. */
export type Outcome = QuizVerdict | 'skipped';

export interface Score {
  correct: number;
  wrong: number;
  skipped: number;
  /** Questions answered (skips don't count). */
  answered: number;
}

export function tally(outcomes: Outcome[]): Score {
  const score = { correct: 0, wrong: 0, skipped: 0, answered: 0 };
  for (const o of outcomes) {
    score[o]++;
    if (o !== 'skipped') score.answered++;
  }
  return score;
}

/** "3 of 5 right · 2 skipped": skips only when there are some. */
export function describeScore(score: Score): string {
  const parts = [`${score.correct} of ${score.answered} right`];
  if (score.skipped) parts.push(`${score.skipped} skipped`);
  return parts.join(' · ');
}

export const VERDICT_LABEL: Record<QuizVerdict, string> = {
  correct: 'Right',
  wrong: 'Not quite',
};

/** A, B, C, D. */
export const optionLetter = (i: number) => String.fromCharCode(65 + i);
