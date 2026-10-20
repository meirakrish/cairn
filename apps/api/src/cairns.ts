import {
  NotFoundError,
  sourceDto,
  type Cairn as CairnRow,
  type CairnService,
  type IngestQueue,
  type ObjectStore,
  type SourceService,
} from '@cairn/core';
import {
  CreateCairnRequest,
  type Cairn,
  type CairnResponse,
  type ListCairnsResponse,
  type ListSourcesResponse,
  type SourceResponse,
} from '@cairn/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireUser } from './auth/middleware';
import type { Config } from './config';
import { HttpError } from './errors';
import { cleanFilename, detectKind, readUpload } from './upload';

function toDto({ id, name, description, embedModel, createdAt }: CairnRow): Cairn {
  return { id, name, description, embedModel, createdAt: createdAt.toISOString() };
}

// A uuid route param. Malformed ids are ids that don't exist (and would otherwise be a Postgres cast error).
export function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !z.uuid().safeParse(value).success)
    throw new NotFoundError(what);
  return value;
}

export interface CairnsRouterDeps {
  config: Config;
  cairns: CairnService;
  sources: SourceService;
  storage: ObjectStore;
  ingest: IngestQueue;
}

export function cairnsRouter({ config, cairns, sources, storage, ingest }: CairnsRouterDeps) {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const body: ListCairnsResponse = { cairns: (await cairns.list(req.user!.id)).map(toDto) };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = CreateCairnRequest.parse(req.body);
    const body: CairnResponse = { cairn: toDto(await cairns.create(req.user!.id, input)) };
    res.status(201).json(body);
  });

  router.get('/:id', async (req, res) => {
    const cairn = await cairns.get(req.user!.id, idParam(req, 'id', 'cairn'));
    if (!cairn) throw new NotFoundError('cairn');
    const body: CairnResponse = { cairn: toDto(cairn) };
    res.json(body);
  });

  router.get('/:id/sources', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    if (!(await cairns.get(userId, cairnId))) throw new NotFoundError('cairn');
    const body: ListSourcesResponse = {
      sources: (await sources.list(userId, cairnId)).map(sourceDto),
    };
    res.json(body);
  });

  // Upload one file: stored in object storage, then queued for the worker. 202: processing is async.
  router.post('/:id/sources', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    if (!(await cairns.get(userId, cairnId))) throw new NotFoundError('cairn');

    const upload = await readUpload(req, config.uploadMaxBytes);
    if (upload.data.length === 0) throw new HttpError(400, 'the file is empty');
    const filename = cleanFilename(upload.filename);
    const detected = detectKind(filename, upload.data);
    if (!detected) throw new HttpError(415, 'only text, Markdown and PDF files are supported');

    const source = await sources.create(userId, cairnId, {
      ...detected,
      filename,
      size: upload.data.length,
    });
    try {
      await storage.put(source.storageKey, upload.data, detected.mime);
    } catch (err) {
      await sources.delete(userId, source.id);
      throw err;
    }
    try {
      await ingest.enqueue({ sourceId: source.id, userId });
    } catch (err) {
      await sources.fail(userId, source.id, 'could not queue the file for processing');
      throw err;
    }

    const body: SourceResponse = { source: sourceDto(source) };
    res.status(202).json(body);
  });

  router.delete('/:id/sources/:sourceId', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const source = await sources.get(userId, idParam(req, 'sourceId', 'source'));
    if (!source || source.cairnId !== cairnId) throw new NotFoundError('source');

    await ingest.remove(source.id);
    await sources.delete(userId, source.id);
    // The row is gone either way; a leftover object is only wasted space, so don't fail the request.
    await storage.delete(source.storageKey).catch((err: unknown) => {
      console.warn(`could not delete ${source.storageKey}:`, err);
    });
    res.status(204).end();
  });

  return router;
}
