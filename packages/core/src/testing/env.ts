import { existsSync } from 'node:fs';

const envFile = new URL('../../../../.env', import.meta.url);

function withPath(url: string, path: string): string {
  const u = new URL(url);
  u.pathname = path;
  return u.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (tests read it from the environment or the root .env)`);
  return value;
}

// Tests reuse the dev connection settings but a separate database (cairn_test) and Redis db 15,
// so they never touch dev data. Already-set env vars (CI) win over the .env file.
export function testEnv() {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const database = process.env.TEST_DATABASE_NAME ?? 'cairn_test';
  const adminUrl = required('DATABASE_ADMIN_URL');
  return {
    database,
    maintenanceUrl: withPath(adminUrl, '/postgres'),
    adminUrl: withPath(adminUrl, `/${database}`),
    appUrl: withPath(required('DATABASE_URL'), `/${database}`),
    redisUrl: withPath(required('REDIS_URL'), '/15'),
  };
}
