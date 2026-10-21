/** The thing does not exist, or RLS hides it from the caller; callers can't tell which, by design. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/** The caller can see the thing but may not do this to it (e.g. a viewer managing shares). */
export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
}

/** The request clashes with existing state (e.g. a second live share for the same email). */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

/** Input the service rejects; the message is safe to show. */
export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
}
