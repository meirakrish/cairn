import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Migrations run as postgres (table owner); the app connects as cairn_app.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? '' },
});
