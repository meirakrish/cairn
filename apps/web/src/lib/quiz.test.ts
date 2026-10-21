import { describe, expect, it } from 'vitest';
import { cheer, describeScore, optionLetter, streak, tally, type Outcome } from './quiz';

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

describe('cheer', () => {
  const of = (...o: Outcome[]) => cheer(tally(o));

  it('celebrates good scores and stays kind to the rest', () => {
    expect(of('correct', 'correct', 'correct')).toMatchObject({
      title: 'Perfect score!',
      party: true,
    });
    expect(of('correct', 'correct', 'correct', 'correct', 'wrong')).toMatchObject({
      title: 'Great job!',
      party: true,
    });
    expect(of('correct', 'wrong')).toMatchObject({ title: 'Nicely done', party: false });
    expect(of('wrong', 'wrong', 'correct')).toMatchObject({ title: 'Good practice', party: false });
  });

  it('needs three answers to throw a party, and none to say goodbye', () => {
    expect(of('correct', 'correct').party).toBe(false);
    expect(of('skipped')).toMatchObject({ title: 'Quiz done', party: false });
  });
});

describe('streak', () => {
  it('counts the right answers at the end, skips passing through', () => {
    expect(streak(['wrong', 'correct', 'correct'])).toBe(2);
    expect(streak(['correct', 'skipped', 'correct'])).toBe(2);
    expect(streak(['correct', 'wrong'])).toBe(0);
    expect(streak([])).toBe(0);
  });
});
