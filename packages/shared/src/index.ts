import { z } from 'zod';

export const HealthResponse = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const User = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type User = z.infer<typeof User>;

export const MeResponse = z.object({ user: User });
export type MeResponse = z.infer<typeof MeResponse>;

/** The caller's relation to a cairn: its owner, or a share's role. */
export const CairnRole = z.enum(['owner', 'editor', 'viewer']);
export type CairnRole = z.infer<typeof CairnRole>;

export const ShareRole = z.enum(['viewer', 'editor']);
export type ShareRole = z.infer<typeof ShareRole>;

/** cited: answers show their sources. sealed: answers only; sources are not shown. */
export const Visibility = z.enum(['cited', 'sealed']);
export type Visibility = z.infer<typeof Visibility>;

export const Cairn = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  embedModel: z.string(),
  createdAt: z.iso.datetime(),
  role: CairnRole,
  visibility: Visibility,
});
export type Cairn = z.infer<typeof Cairn>;

export const CreateCairnRequest = z.object({
  name: z.string().trim().min(1).max(100),
  description: z
    .string()
    .trim()
    .max(1000)
    .transform((d) => d || null)
    .nullish(),
});
export type CreateCairnRequest = z.infer<typeof CreateCairnRequest>;

export const CairnResponse = z.object({ cairn: Cairn });
export type CairnResponse = z.infer<typeof CairnResponse>;

export const ListCairnsResponse = z.object({ cairns: z.array(Cairn) });
export type ListCairnsResponse = z.infer<typeof ListCairnsResponse>;

export const Share = z.object({
  id: z.uuid(),
  kind: z.enum(['email', 'link']),
  email: z.string().nullable(),
  role: ShareRole,
  visibility: Visibility,
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Link shares: who opened the link. */
  redeemedBy: z.array(z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable() })),
});
export type Share = z.infer<typeof Share>;

const shareOptions = {
  role: ShareRole,
  visibility: Visibility,
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
};

export const CreateShareRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    email: z.string().trim().max(254).pipe(z.email()),
    ...shareOptions,
  }),
  z.object({ kind: z.literal('link'), ...shareOptions }),
]);
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;

/** token: link shares only, returned once; the link is `/s/<token>`. */
export const CreateShareResponse = z.object({ share: Share, token: z.string().optional() });
export type CreateShareResponse = z.infer<typeof CreateShareResponse>;

export const ListSharesResponse = z.object({ shares: z.array(Share) });
export type ListSharesResponse = z.infer<typeof ListSharesResponse>;

export const RedeemShareLinkResponse = z.object({ cairnId: z.uuid() });
export type RedeemShareLinkResponse = z.infer<typeof RedeemShareLinkResponse>;

export const SourceKind = z.enum(['text', 'markdown', 'pdf', 'csv']);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceStatus = z.enum(['pending', 'processing', 'ready', 'failed']);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const Source = z.object({
  id: z.uuid(),
  cairnId: z.uuid(),
  kind: SourceKind,
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  status: SourceStatus,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Source = z.infer<typeof Source>;

export const SourceResponse = z.object({ source: Source });
export type SourceResponse = z.infer<typeof SourceResponse>;

export const ListSourcesResponse = z.object({ sources: z.array(Source) });
export type ListSourcesResponse = z.infer<typeof ListSourcesResponse>;

/**
 * Messages on GET /api/cairns/:id/events (SSE `data:` lines). A snapshot comes first, then one
 * message per change.
 */
export const SourceEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), sources: z.array(Source) }),
  z.object({ type: z.literal('source'), source: Source }),
  z.object({ type: z.literal('source_deleted'), sourceId: z.uuid() }),
]);
export type SourceEvent = z.infer<typeof SourceEvent>;

export const QueryRequest = z.object({ question: z.string().trim().min(1).max(1000) });
export type QueryRequest = z.infer<typeof QueryRequest>;

export const ChunkLocation = z.object({
  page: z.number().int().optional(),
  headings: z.array(z.string()).optional(),
  offset: z.number().int().optional(),
  rows: z.tuple([z.number().int(), z.number().int()]).optional(),
});

/** A passage handed to the model, numbered as the answer cites it ([1], [2], ...). */
export const CitedPassage = z.object({
  n: z.number().int().min(1),
  sourceId: z.uuid(),
  filename: z.string(),
  kind: SourceKind,
  location: ChunkLocation,
  text: z.string(),
});
export type CitedPassage = z.infer<typeof CitedPassage>;

/**
 * Messages on POST /api/cairns/:id/query (SSE `data:` lines): the passages, the answer text in pieces,
 * then which passages it cited. `error` replaces the rest if answering fails midway.
 */
export const AnswerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('passages'), passages: z.array(CitedPassage) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    cited: z.array(z.number().int()),
    latencyMs: z.number().int(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AnswerEvent = z.infer<typeof AnswerEvent>;

/**
 * Messages on POST /api/cairns/:id/query for sealed callers: only the answer text and the end. By
 * design there is no type for passages or citations to travel in; the text has had verbatim runs
 * from the documents replaced with "…".
 */
export const SealedAnswerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done'), latencyMs: z.number().int() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type SealedAnswerEvent = z.infer<typeof SealedAnswerEvent>;
