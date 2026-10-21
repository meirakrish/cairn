/** One page of `items`: `page` is 1-based and clamped to the pages that exist (at least one). */
export function paginate<T>(
  items: readonly T[],
  page: number,
  size: number,
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), pages);
  return { items: items.slice((current - 1) * size, current * size), page: current, pages };
}
