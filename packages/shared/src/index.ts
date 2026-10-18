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
