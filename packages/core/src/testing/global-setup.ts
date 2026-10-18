import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { testEnv } from './env';

const quiet = { onnotice: () => {} };

// Vitest globalSetup: creates the test database and app role if missing, then migrates.
// Mirrors deploy/base/postgres/init-db.sh so a bare Postgres (CI) works too.
export default async function setup() {
  const env = testEnv();

  const maintenance = postgres(env.maintenanceUrl, quiet);
  const app = new URL(env.appUrl);
  const role = decodeURIComponent(app.username);
  const [roleExists] = await maintenance`select 1 from pg_roles where rolname = ${role}`;
  if (!roleExists) {
    const password = decodeURIComponent(app.password).replaceAll("'", "''");
    await maintenance.unsafe(
      `create role "${role}" login password '${password}' nosuperuser nobypassrls`,
    );
  }
  const [dbExists] = await maintenance`select 1 from pg_database where datname = ${env.database}`;
  if (!dbExists) await maintenance.unsafe(`create database "${env.database}"`);
  await maintenance.end();

  const admin = postgres(env.adminUrl, quiet);
  await admin.unsafe(`
    create extension if not exists vector;
    grant connect on database "${env.database}" to "${role}";
    grant usage on schema public to "${role}";
    alter default privileges in schema public grant select, insert, update, delete on tables to "${role}";
    alter default privileges in schema public grant usage, select on sequences to "${role}";
  `);
  await migrate(drizzle(admin), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
  await admin.end();
}
