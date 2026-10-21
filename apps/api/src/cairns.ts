import {
  NotFoundError,
  sourceDto,
  type CairnAccess,
  type CairnService,
  type CairnWithAccess,
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

function toDto({ id, name, description, embedModel, createdAt, access }: CairnWithAccess): Cairn {
  return {
    id,
    name,
    description,
    embedModel,
    createdAt: createdAt.toISOString(),
    role: access.role,
    visibility: access.visibility,
  };
}

/** The caller's access to a cairn; a cairn they can't see is a 404. */
export async function requireAccess(
  cairns: CairnService,
  userId: string,
  cairnId: string,
): Promise<CairnAccess> {
  const cairn = await cairns.get(userId, cairnId);
  if (!cairn) throw new NotFoundError('cairn');
  return cairn.access;
}

/** Sealed callers never see sources: not the list, not their status stream. */
export function requireCited(access: CairnAccess): void {
  if (access.visibility === 'sealed')
    throw new HttpError(403, 'sources are not shown for this cairn');
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
    requireCited(await requireAccess(cairns, userId, cairnId));
    const body: ListSourcesResponse = {
      sources: (await sources.list(userId, cairnId)).map(sourceDto),
    };
    res.json(body);
  });

  // Upload one file: stored in object storage, then queued for the worker. 202: processing is async.
  router.post('/:id/sources', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const { role } = await requireAccess(cairns, userId, cairnId);
    if (role === 'viewer') throw new HttpError(403, 'only the owner and editors can add sources');

    const upload = await readUpload(req, config.uploadMaxBytes);
    if (upload.data.length === 0) throw new HttpError(400, 'the file is empty');
    const filename = cleanFilename(upload.filename);
    const detected = detectKind(filename, upload.data);
    if (!detected) throw new HttpError(415, 'only text, Markdown, PDF and CSV files are supported');

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
    const access = await requireAccess(cairns, userId, cairnId);
    requireCited(access);
    if (access.role !== 'owner') throw new HttpError(403, 'only the owner can delete sources');
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
