/**
 * A failure that retrying cannot fix (unsupported content, no text, too large). The message is shown
 * to the user as the source's error, so keep it short and free of internals.
 */
export class PermanentIngestError extends Error {
  override name = 'PermanentIngestError';
}
