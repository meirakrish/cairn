import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  API_PORT: z.coerce.number().default(3000),
  // The browser-facing origin (web and /api share it). Used for the OAuth redirect and the Origin check.
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // Stored on each new cairn; changing it later means re-indexing that cairn.
  EMBED_MODEL: z.string().min(1).default('qwen3-embedding:0.6b'),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Decimal megabytes (1 MB = 1,000,000 bytes), matching the limit shown in error messages.
  UPLOAD_MAX_MEGA_BYTES: z.coerce.number().positive().default(25),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  return {
    port: e.API_PORT,
    appOrigin: e.APP_ORIGIN,
    secureCookies: e.NODE_ENV === 'production',
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedModel: e.EMBED_MODEL,
    uploadMaxBytes: Math.floor(e.UPLOAD_MAX_MEGA_BYTES * 1_000_000),
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: `${e.APP_ORIGIN}/api/auth/google/callback`,
    },
  };
}
