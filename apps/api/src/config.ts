import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  API_PORT: z.coerce.number().default(3000),
  // The browser-facing origin (web and /api share it). Used for the OAuth redirect and the Origin check.
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
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
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: `${e.APP_ORIGIN}/api/auth/google/callback`,
    },
  };
}
