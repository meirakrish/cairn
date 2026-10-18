# Cairn

Knowledge bases ("cairns") built from your documents, queryable and shareable in **cited** mode (answers link their sources) or **sealed** mode (answers only, sources not shown).

- Design: [DESIGN.md](DESIGN.md)
- Progress and next steps: [ROADMAP.md](ROADMAP.md)

## Layout

```
apps/web         SvelteKit UI (static SPA)
apps/api         Express API
packages/core    domain services and database schema
packages/shared  zod schemas and types shared by web and api
deploy/          Kustomize: base + minikube overlay
scripts/         dev helpers
```

## Prerequisites

- WSL2 (or Linux) with Node 22.18+, pnpm 12, Docker, minikube, kubectl

## Dev setup

Apps run on WSL with `pnpm dev`; Postgres (pgvector), Redis and Garage (S3-compatible storage) run in minikube.

1. Start the cluster (first time creates the `cairn` profile):

   ```bash
   minikube start -p cairn --driver=docker --cpus=4 --memory=4g --disk-size=30g
   ```

2. Create the env files. The defaults work for local dev; passwords in both files must match:

   ```bash
   cp deploy/overlays/minikube/secrets.env.example deploy/overlays/minikube/secrets.env
   cp .env.example .env
   ```

   Then fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. In Google Cloud Console → Google Auth Platform: configure the consent screen (External, Testing, add yourself as a test user), then create an OAuth client of type _Web application_ with authorized redirect URI `http://localhost:5173/api/auth/google/callback`.

3. Deploy the infrastructure and wait for it. A one-off Job sets up Garage (layout, access key, `cairn` bucket):

   ```bash
   pnpm infra:up
   pnpm infra:status
   ```

4. In a separate terminal, forward the services to localhost (Postgres :5432, Redis :6379, Garage S3 :3900):

   ```bash
   pnpm infra:forward
   ```

5. Install, migrate and run the apps (api on :3000, web on http://localhost:5173, which proxies `/api` to the api):

   ```bash
   pnpm install
   pnpm db:migrate
   pnpm dev
   ```

## Commands

| Command              | What it does                                                      |
| -------------------- | ----------------------------------------------------------------- |
| `pnpm dev`           | Run api and web in watch mode                                     |
| `pnpm build`         | Build all packages                                                |
| `pnpm lint`          | ESLint                                                            |
| `pnpm typecheck`     | TypeScript and svelte-check                                       |
| `pnpm format`        | Prettier (`format:check` to verify only)                          |
| `pnpm test`          | Vitest: core and api against `cairn_test` (needs `infra:forward`) |
| `pnpm db:generate`   | Generate a SQL migration from the Drizzle schema                  |
| `pnpm db:migrate`    | Apply pending migrations as `postgres`                            |
| `pnpm infra:up`      | Apply the minikube overlay                                        |
| `pnpm infra:status`  | Show pods, volumes and jobs                                       |
| `pnpm infra:forward` | Port-forward Postgres, Redis and Garage to localhost              |
| `pnpm infra:reset`   | Delete everything in the `cairn` namespace, **including data**    |

The `infra:*` scripts use the kubectl context `cairn`; override with `KUBE_CONTEXT=<name>`. To pause the cluster and keep data, run `minikube stop -p cairn`.

## Database roles

- `cairn_app`: what the api uses (`DATABASE_URL`). Not a superuser and cannot bypass row-level security.
- `postgres`: owns the tables and runs migrations (`DATABASE_ADMIN_URL`).

## Schema changes

Edit `packages/core/src/db/schema.ts`, run `pnpm db:generate --name <what>`, review the SQL in `packages/core/drizzle/`, then `pnpm db:migrate`. RLS policies are declared in the schema with `pgPolicy`. Queries that touch RLS tables go through `withUser(db, userId, tx => …)`, which sets `app.user_id` for that transaction.

## Auth

Google sign-in is handled entirely by the api (authorization code flow with PKCE, state and nonce):

- `GET /api/auth/google/start` → redirects to Google; `GET /api/auth/google/callback` verifies the ID token, upserts the user and sets the `cairn_sid` cookie (httpOnly, `SameSite=Lax`, 14 days).
- `GET /api/auth/me` → the current user, or 401. `POST /api/auth/logout` → ends the session.
- Sessions live in Redis under `session:<sha256(sid)>`. Mutating requests must send `Origin: $APP_ORIGIN`.

## API

All routes are under `/api` and return JSON. Errors are `{ "error": "..." }`; validation errors (400) also carry `issues`.

| Route                   | Auth | What it does                                   |
| ----------------------- | ---- | ---------------------------------------------- |
| `GET /api/health`       | no   | Liveness                                       |
| `GET /api/auth/me`      | yes  | Current user                                   |
| `POST /api/auth/logout` | yes  | End the session                                |
| `GET /api/cairns`       | yes  | Your cairns, newest first                      |
| `POST /api/cairns`      | yes  | Create a cairn: `{ name, description? }` → 201 |

Request and response shapes are the zod schemas in `packages/shared`.

## Tests

`pnpm test` runs Vitest over `packages/core` and `apps/api` against real Postgres and Redis, using the root `.env` connection settings but a separate `cairn_test` database and Redis db 15, so dev data is untouched. A global setup creates the database (and the `cairn_app` role, if missing), then applies migrations. Each test truncates all tables and flushes the Redis db.

- `packages/core`: `CairnService`, user upsert, and RLS isolation (cross-user reads, writes, spoofed owners, no user set).
- `apps/api`: supertest over the real app: sessions, logout, Origin check, the Google callback (Google's token exchange and ID token check are mocked), and `/api/cairns`.

Helpers live in `@cairn/core/testing` and `apps/api/src/testing.ts`.

CI (`.github/workflows/ci.yml`) runs the same checks on every PR and push to `main`, with Postgres (pgvector) and Redis as service containers, plus a `kubectl kustomize` build of the minikube overlay.
