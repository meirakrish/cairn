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

export interface Cheer {
  emoji: string;
  title: string;
  /** Worth confetti. */
  party: boolean;
}

/** The end-of-quiz headline: warm at every score, festive from 80% of at least three answers. */
export function cheer(score: Score): Cheer {
  if (score.answered === 0) return { emoji: '👋', title: 'Quiz done', party: false };
  const share = score.correct / score.answered;
  if (share === 1 && score.answered >= 3)
    return { emoji: '🏆', title: 'Perfect score!', party: true };
  if (share >= 0.8 && score.answered >= 3) return { emoji: '🎉', title: 'Great job!', party: true };
  if (share >= 0.5) return { emoji: '👏', title: 'Nicely done', party: false };
  return { emoji: '🌱', title: 'Good practice', party: false };
}

/** Right answers in a row at the end of the quiz; skips don't break a streak. */
export function streak(outcomes: Outcome[]): number {
  let n = 0;
  for (const o of [...outcomes].reverse()) {
    if (o === 'correct') n++;
    else if (o === 'wrong') break;
  }
  return n;
}
