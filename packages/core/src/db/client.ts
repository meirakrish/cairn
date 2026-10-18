import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url);
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

// Runs fn in a transaction where RLS sees userId as the current user.
// The setting is transaction-local, so it never leaks to the next pooled query.
export function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
