/** The thing does not exist, or RLS hides it from the caller; callers can't tell which, by design. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(what: string) {
    super(`${what} not found`);
  }
}
