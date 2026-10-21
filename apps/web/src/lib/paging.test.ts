import { describe, expect, it } from 'vitest';
import { paginate } from './paging';

const items = Array.from({ length: 25 }, (_, i) => i + 1);

describe('paginate', () => {
  it('returns the requested page and the page count', () => {
    expect(paginate(items, 1, 12)).toEqual({ items: items.slice(0, 12), page: 1, pages: 3 });
    expect(paginate(items, 3, 12)).toEqual({ items: [25], page: 3, pages: 3 });
  });

  it('clamps pages that do not exist', () => {
    expect(paginate(items, 9, 12).page).toBe(3);
    expect(paginate(items, 0, 12).page).toBe(1);
    expect(paginate(items, Number.NaN, 12).page).toBe(1);
  });

  it('has one empty page when there is nothing', () => {
    expect(paginate([], 1, 12)).toEqual({ items: [], page: 1, pages: 1 });
  });
});
