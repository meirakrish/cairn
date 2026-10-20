import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, users, type Db, type User } from '../db';
import { testEnv } from './env';

export { testEnv };
export { makePdf } from './pdf';
/** Creates and migrates the test database (the Vitest global setup); TEST_DATABASE_NAME picks another one. */
export { default as prepareTestDatabase } from './global-setup';

// admin bypasses RLS (fixtures, assertions); app is cairn_app, subject to RLS like the api.
export function createTestDbs() {
  const env = testEnv();
  return { admin: createDb(env.adminUrl), app: createDb(env.appUrl) };
}

export async function resetDb(admin: Db): Promise<void> {
  const rows = await admin.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (tables) await admin.execute(sql.raw(`truncate ${tables} cascade`));
}

export async function createUser(admin: Db, overrides: Partial<User> = {}): Promise<User> {
  const sub = overrides.googleSub ?? randomUUID();
  const [user] = await admin
    .insert(users)
    .values({ googleSub: sub, email: `${sub}@example.test`, ...overrides })
    .returning();
  return user!;
}
