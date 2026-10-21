import {
  checkWebUrl,
  NotFoundError,
  PermanentIngestError,
  sourceDto,
  type CairnAccess,
  type CairnService,
  type CairnWithAccess,
  type IngestQueue,
  type Moderator,
  type ObjectStore,
  type SourceService,
} from '@cairn/core';
import {
  AddUrlRequest,
  CreateCairnRequest,
  type DuplicateUrlResponse,
  type Cairn,
  type CairnResponse,
  type ListCairnsResponse,
  type ListSourcesResponse,
  type SourceResponse,
  UpdateCairnRequest,
} from '@cairn/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireUser } from './auth/middleware';
import type { Config } from './config';
import { HttpError } from './errors';
import { checkText } from './moderation';
import { cleanFilename, detectKind, readUpload } from './upload';

/** What moderation reads of a cairn: its name and description. */
const cairnText = ({ name, description }: CreateCairnRequest) =>
  description ? `${name}\n\n${description}` : name;

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

/** The URL as stored (checkWebUrl's form, without the #fragment, which names a spot, not a page). */
function webUrl(raw: string): string {
  try {
    const url = checkWebUrl(raw);
    url.hash = '';
    return url.href;
  } catch (err) {
    if (err instanceof PermanentIngestError) throw new HttpError(400, err.message);
    throw err;
  }
}

export interface CairnsRouterDeps {
  config: Config;
  cairns: CairnService;
  sources: SourceService;
  storage: ObjectStore;
  ingest: IngestQueue;
  moderator: Moderator;
}

export function cairnsRouter({
  config,
  cairns,
  sources,
  storage,
  ingest,
  moderator,
}: CairnsRouterDeps) {
  const router = Router();
  router.use(requireUser);

  // On failure the source stays, marked failed with the reason, so the user sees what happened.
  async function queue(userId: string, sourceId: string, failure: string) {
    try {
      await ingest.enqueue({ sourceId, userId });
    } catch (err) {
      await sources.fail(userId, sourceId, failure);
      throw err;
    }
  }

  router.get('/', async (req, res) => {
    const body: ListCairnsResponse = { cairns: (await cairns.list(req.user!.id)).map(toDto) };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = CreateCairnRequest.parse(req.body);
    await checkText(moderator, cairnText(input));
    const body: CairnResponse = { cairn: toDto(await cairns.create(req.user!.id, input)) };
    res.status(201).json(body);
  });

  router.get('/:id', async (req, res) => {
    const cairn = await cairns.get(req.user!.id, idParam(req, 'id', 'cairn'));
    if (!cairn) throw new NotFoundError('cairn');
    const body: CairnResponse = { cairn: toDto(cairn) };
    res.json(body);
  });

  router.patch('/:id', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const access = await requireAccess(cairns, userId, cairnId);
    if (access.role !== 'owner') throw new HttpError(403, 'only the owner can edit a cairn');
    const input = UpdateCairnRequest.parse(req.body);
    await checkText(moderator, cairnText(input));
    const cairn = await cairns.update(userId, cairnId, input);
    if (!cairn) throw new NotFoundError('cairn');
    const body: CairnResponse = { cairn: toDto(cairn) };
    res.json(body);
  });

  router.delete('/:id', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const access = await requireAccess(cairns, userId, cairnId);
    if (access.role !== 'owner') throw new HttpError(403, 'only the owner can delete a cairn');
    const files = await sources.list(userId, cairnId);
    if (!(await cairns.delete(userId, cairnId))) throw new NotFoundError('cairn');
    // The rows are gone (sources, chunks, shares, questions cascade); now the queued jobs and files.
    // Leftovers are only wasted space, so don't fail the request.
    for (const source of files) {
      await ingest.remove(source.id).catch(() => {});
      await storage.delete(source.storageKey).catch((err: unknown) => {
        console.warn(`could not delete ${source.storageKey}:`, err);
      });
    }
    res.status(204).end();
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

  // Add a source: a file (multipart upload, stored in object storage) or a web page (JSON { url },
  // fetched by the worker). Either way it is queued for the worker; 202: processing is async.
  router.post('/:id/sources', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const { role } = await requireAccess(cairns, userId, cairnId);
    if (role === 'viewer') throw new HttpError(403, 'only the owner and editors can add sources');

    if (req.is('application/json')) {
      const url = webUrl(AddUrlRequest.parse(req.body).url);
      const existing = await sources.findByUrl(userId, cairnId, url);
      if (existing) {
        const body: DuplicateUrlResponse = {
          error: 'this page is already in the cairn; refresh it instead',
          source: sourceDto(existing),
        };
        res.status(409).json(body);
        return;
      }
      // Kind, name, type and size are placeholders until the worker has fetched the page.
      const source = await sources.create(userId, cairnId, {
        kind: 'web',
        filename: url,
        mime: 'text/html',
        size: 0,
        url,
      });
      await queue(userId, source.id, 'could not queue the page for fetching');
      const body: SourceResponse = { source: sourceDto(source) };
      res.status(202).json(body);
      return;
    }

    const upload = await readUpload(req, config.uploadMaxBytes);
    if (upload.data.length === 0) throw new HttpError(400, 'the file is empty');
    const filename = cleanFilename(upload.filename);
    const detected = detectKind(filename, upload.data);
    if (!detected)
      throw new HttpError(
        415,
        'only text, Markdown, PDF, CSV, JSON and image (PNG, JPEG, WebP) files are supported',
      );

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
    await queue(userId, source.id, 'could not queue the file for processing');

    const body: SourceResponse = { source: sourceDto(source) };
    res.status(202).json(body);
  });

  // Fetch a web page again; its chunks are replaced when the new version is ready.
  router.post('/:id/sources/:sourceId/refresh', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const access = await requireAccess(cairns, userId, cairnId);
    requireCited(access);
    if (access.role === 'viewer') {
      throw new HttpError(403, 'only the owner and editors can refresh pages');
    }
    const existing = await sources.get(userId, idParam(req, 'sourceId', 'source'));
    if (!existing || existing.cairnId !== cairnId) throw new NotFoundError('source');
    if (!existing.url) throw new HttpError(400, 'only web pages can be refreshed');

    const source = await sources.requeue(userId, existing.id);
    if (!source) throw new HttpError(409, 'the page is already being fetched');
    // The finished job keeps the source's id, and adding a job under a used id does nothing.
    await ingest.remove(source.id);
    await queue(userId, source.id, 'could not queue the page for fetching');
    const body: SourceResponse = { source: sourceDto(source) };
    res.status(202).json(body);
  });

  // The original of an image source, for previews next to its passages. Images only for now (other
  // kinds would need allow_download); sealed callers never get files. Served inertly: uploads are
  // untrusted, so no sniffing and a CSP that forbids everything if someone opens the URL directly.
  router.get('/:id/sources/:sourceId/file', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    requireCited(await requireAccess(cairns, userId, cairnId));
    const source = await sources.get(userId, idParam(req, 'sourceId', 'source'));
    if (!source || source.cairnId !== cairnId || source.kind !== 'image') {
      throw new NotFoundError('source');
    }
    const data = await storage.get(source.storageKey);
    res.set({
      'Content-Type': source.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(Buffer.from(data));
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
