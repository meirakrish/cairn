import { cairnEventsChannel, sourceDto, type CairnService, type SourceService } from '@cairn/core';
import type { SourceEvent } from '@cairn/shared';
import { Router } from 'express';
import { requireUser } from './auth/middleware';
import type { SessionStore } from './auth/session';
import { idParam, requireAccess, requireCited } from './cairns';
import type { Config } from './config';
import type { EventHub } from './event-hub';

export interface EventsRouterDeps {
  config: Config;
  cairns: CairnService;
  sources: SourceService;
  sessions: SessionStore;
  hub: EventHub;
}

/**
 * GET /api/cairns/:id/events: a Server-Sent Events stream of the cairn's sources. It starts with a
 * snapshot (subscribed first, so nothing falls between the snapshot and the first update), then sends
 * each change. Every heartbeat re-checks the session and the cairn, so logging out, losing access or
 * a share turning sealed ends the stream. Sealed callers get a 403: sources are not shown to them.
 */
export function eventsRouter({ config, cairns, sources, sessions, hub }: EventsRouterDeps) {
  const router = Router();

  router.get('/:id/events', requireUser, async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    requireCited(await requireAccess(cairns, userId, cairnId));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell nginx (the future ingress) not to buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    const send = (event: SourceEvent | string) =>
      res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);

    // The client can disconnect during any await below, so close() must cope with a half-set-up stream.
    const stream: {
      closed: boolean;
      unsubscribe?: () => Promise<void>;
      heartbeat?: NodeJS.Timeout;
    } = {
      closed: false,
    };
    const close = () => {
      if (stream.closed) return;
      stream.closed = true;
      clearInterval(stream.heartbeat);
      void stream.unsubscribe?.();
      res.end();
    };
    req.on('close', close);

    // Messages are already serialized SourceEvents, published by SourceService's listener.
    stream.unsubscribe = await hub.subscribe(cairnEventsChannel(cairnId), (message) => {
      if (!stream.closed) send(message);
    });
    if (stream.closed) return void stream.unsubscribe();
    const snapshot = (await sources.list(userId, cairnId)).map(sourceDto);
    if (stream.closed) return;
    send({ type: 'snapshot', sources: snapshot });

    stream.heartbeat = setInterval(async () => {
      try {
        const session = await sessions.get(req);
        if (session?.userId !== userId) return close();
        const cairn = await cairns.get(userId, cairnId);
        if (cairn?.access.visibility !== 'cited') return close();
        res.write(': ping\n\n');
      } catch {
        close();
      }
    }, config.sseHeartbeatMs);
  });

  return router;
}
