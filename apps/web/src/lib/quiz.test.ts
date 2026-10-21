import { describe, expect, it } from 'vitest';
import { describeScore, optionLetter, tally } from './quiz';

describe('tally', () => {
  it('counts verdicts and leaves skips out of the answered count', () => {
    expect(tally(['correct', 'wrong', 'skipped', 'correct'])).toEqual({
      correct: 2,
      wrong: 1,
      skipped: 1,
      answered: 3,
    });
  });
});

describe('describeScore', () => {
  it('adds skips when there are some', () => {
    expect(describeScore(tally([]))).toBe('0 of 0 right');
    expect(describeScore(tally(['correct', 'wrong']))).toBe('1 of 2 right');
    expect(describeScore(tally(['correct', 'wrong', 'skipped', 'skipped']))).toBe(
      '1 of 2 right · 2 skipped',
    );
  });
});

describe('optionLetter', () => {
  it('letters the options', () => {
    expect([0, 1, 2, 3].map(optionLetter)).toEqual(['A', 'B', 'C', 'D']);
  });
});
