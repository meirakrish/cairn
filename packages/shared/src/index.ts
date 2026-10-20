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

export const Cairn = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  embedModel: z.string(),
  createdAt: z.iso.datetime(),
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

export const SourceKind = z.enum(['text', 'markdown', 'pdf']);
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
