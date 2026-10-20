# Cairn roadmap

Working notes for picking the project up in any session. The design is in [DESIGN.md](DESIGN.md) (open to revision; update it when a decision changes); this file tracks progress. Dev setup is in [README.md](README.md).

## Conventions

- One branch per step: `phase<N>/step<M>-<slug>`, pushed, PR only on request.
- Update this file before every commit.

## Phase 1: foundation (done)

| Step | What                                                                                                         | Status | Branch                  |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------ | ----------------------- |
| 1    | pnpm monorepo, Prettier, ESLint, TS base config                                                              | done   | `phase1/step1-monorepo` |
| 2    | `deploy/`: Kustomize base + minikube overlay (Postgres+pgvector, Redis, Garage), port-forward script, README | done   | `phase1/step2-deploy`   |
| 3    | `packages/core/db`: Drizzle schema + migrations for `users`, `cairns`; RLS on `cairns`                       | done   | `phase1/step3-db`       |
| 4    | Google login: server-side OIDC, Redis session, httpOnly `cairn_sid` cookie                                   | done   | `phase1/step4-auth`     |
| 5    | Cairns: `POST`/`GET /api/cairns` + web list/create page                                                      | done   | `phase1/step5-cairns`   |
| 6    | Tests (Vitest + supertest, RLS isolation)                                                                    | done   | `phase1/step6-tests`    |
| 7    | CI: GitHub Actions (format, lint, typecheck, build, test with pgvector + Redis services, kustomize build)    | done   | `phase1/step7-ci`       |

Decisions made during planning:

- Drizzle schema and `CairnService` live in `packages/core` (the Phase 2 worker reuses them).
- Apps run on WSL with `pnpm dev`; infra in minikube (profile and kubectl context `cairn`, namespace `cairn`) reached via `pnpm infra:forward` (5432, 6379, 3900).
- Postgres app role is non-superuser so RLS applies; per-request `set_config('app.user_id', …, true)` in a transaction.
- CSRF: `SameSite=Lax` plus an Origin check on mutating routes.
- Web is plain CSS, no UI library.
- Dockerfiles and image builds are deferred until apps run in the cluster.
- Object storage is Garage (`dxflrs/garage`, AGPL, S3 API), not MinIO: MinIO stopped publishing images, and we want a plain open-source project rather than a vendor free tier.
- Drizzle 0.45 (stable, not the 1.0 beta) with postgres.js. Migrations are drizzle-kit generated SQL, committed, applied with `drizzle-kit migrate` as `postgres`.
- RLS: `cairns_owner` policy, `owner_id = nullif(current_setting('app.user_id', true), '')::uuid`; no user set → no rows. `users` has no RLS (login looks users up by `google_sub` before a user id exists).
- `cairns.embed_model` is NOT NULL without a default; `CairnService` (step 5) fills it from config.
- Auth (step 4): `google-auth-library` code flow with PKCE + state + nonce. State is single-use in Redis (`oauth:state:*`, 10 min, `GETDEL`) and bound to the browser by a `cairn_oauth_state` cookie. Requires `email_verified`. Login always rotates the session id.
- Sessions: random 32-byte id in `cairn_sid`; Redis key is `session:<sha256(id)>`, fixed 14-day TTL (no sliding). `Secure` cookies only when `NODE_ENV=production`.
- Redis client is `ioredis` (BullMQ uses it in Phase 2).
- `createApp({ config, db, redis })` takes its dependencies so step 6 tests can inject them. Config is parsed with zod in `apps/api/src/config.ts`.
- Cairns (step 5): `CairnService` in core runs every query through `withUser`, so RLS (not a `where owner_id`) scopes lists. `embed_model` comes from `EMBED_MODEL` (default `qwen3-embedding:0.6b`). The api maps rows to the shared `Cairn` DTO (`createdAt` as ISO string).
- api errors: `ZodError` → 400 with `issues`; body-parser 4xx passed through; unknown `/api/*` → 404 JSON; everything else 500.
- Web: one page at `/`, a sign-in screen or the cairn list plus a create form; `#lib/api.ts` wraps fetch, throws `ApiError`, and parses responses with the shared schemas. Logo is `#lib/Logo.svelte` (stone colours from `--stone-*` CSS vars, top stone `--accent`); `assets/favicon.svg` is the same drawing with fixed colours, so keep them in sync. The header renders only when signed in.
- Tests (step 6): one root `vitest.config.ts` (Vitest 5), `fileParallelism: false` because files share one DB. Real Postgres/Redis, no DB mocks; only Google (`OAuth2Client.prototype.getToken`/`verifyIdToken`) is mocked. Test DB `cairn_test` (override with `TEST_DATABASE_NAME`) and Redis db 15, derived from `DATABASE_ADMIN_URL`/`DATABASE_URL`/`REDIS_URL`. Global setup creates the app role if missing, so CI can use a bare `pgvector/pgvector` service with only `postgres`.
- Login rotates the session via `SessionStore.revoke` (old Redis key) + `create`; it no longer clears and sets `cairn_sid` in the same response.
- CI (step 7): `.github/workflows/ci.yml`, on push to main and PRs. Job `check` runs format, lint, typecheck, build and test against `pgvector/pgvector` + `redis` service containers (same images as deploy/base, no Redis password); job `deploy` runs `kubectl kustomize` on the minikube overlay after copying `secrets.env.example`. Node from `.nvmrc`, pnpm from `packageManager`.
- DB roles: `postgres` owns tables and runs migrations (`DATABASE_ADMIN_URL`); the api uses `cairn_app` (`DATABASE_URL`), created by `deploy/base/postgres/init-db.sh` with default privileges on tables `postgres` creates.

## Phase 2: ingest

| Step | What                                                                                                                     | Status | Branch                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------- |
| 1    | llm-kit v0.2 (in the llm-kit repo): `Embedder` (Ollama + OpenAI), `EMBED_*` config, `fakeEmbedder`; published as `0.2.0` | done   | llm-kit `feat/embedder` |
| 2    | Schema: `sources`, `chunks` (`vector(1024)` + HNSW, generated `tsv` + GIN), RLS via the parent cairn; core services      | done   | `phase2/step2-schema`   |
| 3    | Upload api: `ObjectStore` over Garage, `GET /api/cairns/:id`, sources list/upload/delete, MIME sniffing, BullMQ enqueue  | next   |                         |
| 4    | `apps/worker`: BullMQ job extract → chunk → embed → store, `pending → processing → ready \| failed`                      | todo   |                         |
| 5    | Live status: worker publishes on Redis pub/sub, api streams `GET /api/cairns/:id/events` (SSE)                           | todo   |                         |
| 6    | Web: `/cairns/[id]` with drag-and-drop upload, live source list, delete                                                  | todo   |                         |

Each step brings its own tests.

Step 2 as built:

- `sources` (kind and status are text + CHECK, not pg enums, so adding a value is a one-line migration), `updated_at` for status changes, `created_by` set null if the user goes.
- `chunks`: composite FK `(source_id, cairn_id) → sources(id, cairn_id)` so a chunk can't sit in another cairn; `unique(source_id, ordinal)`; `embedding vector(1024)` (`EMBEDDING_DIMENSIONS` in core) with HNSW `vector_cosine_ops`; `tsv` generated from `to_tsvector('simple', content)` with GIN.
- RLS policies `sources_cairn` / `chunks_cairn`: `exists (select 1 from cairns where id = cairn_id)`, which inherits cairns' RLS. Phase 4 must narrow writes to editors and hide sources from sealed callers.
- `SourceService` (core): `create` (id chosen up front, key `cairns/<cairnId>/sources/<id>`, `NotFoundError` if the cairn isn't visible), `list`, `get`, `delete` (returns the row for file cleanup), and for the worker `markProcessing` (from pending/processing/failed only, so duplicate jobs no-op), `complete` (replace chunks + ready, one transaction, 200-row inserts), `fail` (error capped at 500 chars), `listChunks`. `CairnService.get` added.

Plan decisions (agreed 2026-10-18):

- `stream()` moves from llm-kit v0.2 to Phase 3, where answers are streamed.
- Embeddings: `qwen3-embedding:0.6b` at 1024 dims (`EMBED_DIMENSIONS=1024`), so the HNSW index survives a provider change (text-embedding-3 can also return 1024).
- The worker runs each job as the uploader via `withUser` (job carries the user id): no RLS-bypassing role.
- RLS on `sources`/`chunks`: visible when the parent cairn is visible, so Phase 4 only widens the cairn policy.
- Uploads: 25 MB/file, type sniffed from bytes, only text/Markdown/PDF, key `cairns/<cairnId>/sources/<sourceId>`, owner-only until Phase 4.
- Extraction: PDF via `unpdf` (page per chunk), Markdown keeps the heading path, text keeps a char offset; caps on pages, chars and time.
- Chunking: own splitter, ~600 tokens (≈2400 chars) with ~15% overlap, preferring paragraph then sentence boundaries.
- `tsv` uses the `simple` text-search config (language-agnostic).
- Tests use an in-memory `ObjectStore`; CI gets no Garage. The S3 store is checked by hand against Garage.
- Worker runs in `pnpm dev` on WSL; `OLLAMA_HOST` points at the Windows host. The in-cluster `ollama` Service waits until apps run in the cluster.

## Current layout

```
apps/web         SvelteKit 3 SPA (adapter-static, ssr=false); dev proxy /api → localhost:3000; root layout loads /api/auth/me; src/lib/api.ts, src/lib/app.css
apps/api         Express 5; src/config.ts (zod env), src/auth/ (google, session, middleware: originCheck, loadUser, requireUser); src/cairns.ts (router); error handler in app.ts; src/testing.ts (createTestApp, setCookie); *.test.ts next to the code; dev with tsx watch, build with tsdown → dist/index.mjs
packages/shared  zod schemas/types (HealthResponse, User, MeResponse)
packages/core    src/testing/ (@cairn/core/testing: testEnv, global-setup, createTestDbs, resetDb, createUser); src/db: Drizzle schema (users, cairns, sources, chunks + RLS policies), createDb(), withUser(); src/users.ts (upsertGoogleUser, getUser); src/cairns.ts (CairnService); src/sources.ts (SourceService, storageKey); src/errors.ts (NotFoundError); drizzle/ SQL migrations
deploy/base      postgres/ (pgvector pg17, init-db.sh), redis/, garage/ (garage.toml, bootstrap Job)
deploy/overlays/minikube  namespace cairn, cairn-secrets from secrets.env, resource limits
scripts/infra-forward.sh  port-forwards with auto-retry
.github/workflows/ci.yml  CI
```

## Gotchas

- TypeScript is pinned to `~6.0`: SvelteKit 3 requires TS 6, typescript-eslint supports `<6.1`.
- SvelteKit 3 has no `svelte.config.js`; config is in `vite.config.ts`, and `tsconfig.json` extends `$app/tsconfig`.
- pnpm 12 blocks dependency build scripts; allowed ones are listed under `allowBuilds` in `pnpm-workspace.yaml`.
- Workspace packages export TypeScript source (`./src/index.ts`); the api bundles them via `noExternal` in `tsdown.config.ts`.
- TS 6 defaults `types` to `[]`; node packages set `"types": ["node"]`.
- `DESIGN.md` is in `.prettierignore` so its tables stay as written.
- Postgres `init-db.sh` only runs on an empty data dir; to rerun it, `pnpm infra:reset` (wipes data) then `pnpm infra:up`.
- Garage bootstrap Job is idempotent and has `ttlSecondsAfterFinished: 300`; if `infra:up` fails with "field is immutable" on the Job, delete it (`kubectl --context cairn -n cairn delete job garage-bootstrap`) and reapply.
- Garage `/health` returns 503 until a layout exists, so readiness is a TCP probe. Garage access key IDs must be `GK` + 24 hex chars.
- `drizzle.config.ts` loads the root `.env` itself (`process.loadEnvFile`), so `pnpm db:migrate` needs `pnpm infra:forward` running.
- Ad-hoc scripts importing core under tsx: use `.mts` (tsx treats a `.ts` outside a `type: module` package as CJS, so no top-level await).
- The api refuses to start without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env` (zod config).
- The Google redirect URI points at the web origin (`:5173`), not the api, so the cookie is set on the origin the browser uses; the Vite proxy forwards it.
- `#lib/*` imports in apps/web need the file extension (`#lib/api.ts`).
- svelte/no-navigation-without-resolve flags `<a href="/api/...">`; the sign-in uses a `<form method="get">` instead.
- Augment Express's `Request` through `declare global { namespace Express }` (`apps/api/src/express.d.ts`); `express-serve-static-core` can't be resolved under pnpm.
- Test files in apps/api can't import `drizzle-orm` directly (it's a core dependency, not an api one); go through `@cairn/core`.
- Verified the RLS tests bite: disabling RLS on `cairn_test.cairns` fails 6 tests.
- When bumping the Postgres or Redis image in deploy/base, bump the CI service images too.
- Composite-key and unique violations fire in index order: a test meant to hit `chunks_source_fk` hit `chunks_source_ordinal_key` first. Pick values that only break the constraint under test.
- Ollama is reached from WSL at the Windows host IP (`OLLAMA_HOST=http://172.19.208.1:11434` today; it can change after a reboot). The Windows firewall rules `ollama.exe` are limited to `172.16.0.0/12` with edge traversal blocked (UDP rule disabled), because the PC has public IPv6 addresses.
- psql is not installed on WSL; use `kubectl --context cairn -n cairn exec -it postgres-0 -- psql -U postgres cairn`.

## Commands

```bash
pnpm infra:up       # deploy postgres, redis, garage to minikube (context cairn)
pnpm infra:forward  # separate terminal
pnpm install
pnpm db:migrate     # after schema changes: pnpm db:generate --name <what>
pnpm dev            # api :3000 + web :5173
pnpm lint && pnpm typecheck && pnpm format:check && pnpm build && pnpm test
```

## Later phases

Phase 2 is above. See the Scope section of DESIGN.md: Phase 2 ingest (llm-kit v0.2: embeddings), Phase 3 query, Phase 4 sharing.
