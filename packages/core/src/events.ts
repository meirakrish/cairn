import type { Source as SourceDto, SourceEvent } from '@cairn/shared';
import type { Redis } from 'ioredis';
import type { Source } from './db';

/** Redis pub/sub channel for live updates about one cairn. */
export function cairnEventsChannel(cairnId: string): string {
  return `cairn:${cairnId}:events`;
}

export function sourceDto(s: Source): SourceDto {
  const { id, cairnId, kind, filename, mime, size, status, error, url } = s;
  return {
    ...{ id, cairnId, kind, filename, mime, size, status, error, url },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** A committed change to a source, reported by SourceService. */
export type SourceChange =
  { kind: 'changed'; source: Source } | { kind: 'deleted'; source: Source };

export type SourceChangeListener = (change: SourceChange) => void | Promise<void>;

export function toEvent(change: SourceChange): SourceEvent {
  return change.kind === 'changed'
    ? { type: 'source', source: sourceDto(change.source) }
    : { type: 'source_deleted', sourceId: change.source.id };
}

/** Publishes source changes to their cairn's channel, for the api's event streams. */
export function redisSourcePublisher(redis: Redis): SourceChangeListener {
  return async (change) => {
    await redis.publish(cairnEventsChannel(change.source.cairnId), JSON.stringify(toEvent(change)));
  };
}
