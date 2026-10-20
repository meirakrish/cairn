import { EMBEDDING_DIMENSIONS } from '@cairn/core';
import { resolveEmbedConfig } from '@meirakrish/llm-kit';
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // One at a time by default: embeddings run on one local GPU.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  EMBED_DIMENSIONS: z.coerce.number().int().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

// No OAuth or session settings: the worker only needs Postgres, Redis, object storage and the embedder.
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  if (e.EMBED_DIMENSIONS !== undefined && e.EMBED_DIMENSIONS !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBED_DIMENSIONS=${e.EMBED_DIMENSIONS}, but chunks.embedding is vector(${EMBEDDING_DIMENSIONS}); changing it needs a migration`,
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    concurrency: e.WORKER_CONCURRENCY,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
    embed: resolveEmbedConfig({ dimensions: EMBEDDING_DIMENSIONS }, env),
  };
}
