# Cairn roadmap

Working notes for picking the project up in any session. The design is in [DESIGN.md](DESIGN.md) (open to revision; update it when a decision changes); this file tracks progress. Dev setup is in [README.md](README.md).

## Conventions

- One branch per step: `phase<N>/step<M>-<slug>`, pushed, PR only on request.
- Update this file before every commit.

## Phase 1: foundation

| Step | What                                                                                                         | Status | Branch                  |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------ | ----------------------- |
| 1    | pnpm monorepo, Prettier, ESLint, TS base config                                                              | done   | `phase1/step1-monorepo` |
| 2    | `deploy/`: Kustomize base + minikube overlay (Postgres+pgvector, Redis, Garage), port-forward script, README | done   | `phase1/step2-deploy`   |
| 3    | `packages/core/db`: Drizzle schema + migrations for `users`, `cairns`; RLS on `cairns`                       | done   | `phase1/step3-db`       |
| 4    | Google login: server-side OIDC, Redis session, httpOnly `cairn_sid` cookie                                   | done   | `phase1/step4-auth`     |
| 5    | Cairns: `POST`/`GET /api/cairns` + web list/create page                                                      | next   |                         |
| 6    | Tests (Vitest + supertest, RLS isolation)                                                                    | todo   |                         |
| 7    | CI: GitHub Actions (format, lint, typecheck, build, test with pgvector + Redis services, kustomize build)    | todo   |                         |

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
- DB roles: `postgres` owns tables and runs migrations (`DATABASE_ADMIN_URL`); the api uses `cairn_app` (`DATABASE_URL`), created by `deploy/base/postgres/init-db.sh` with default privileges on tables `postgres` creates.

## Current layout

```
apps/web         SvelteKit 3 SPA (adapter-static, ssr=false); dev proxy /api → localhost:3000; root layout loads /api/auth/me; src/lib/api.ts, src/lib/app.css
apps/api         Express 5; src/config.ts (zod env), src/auth/ (google, session, middleware: originCheck, loadUser, requireUser); dev with tsx watch, build with tsdown → dist/index.mjs
packages/shared  zod schemas/types (HealthResponse, User, MeResponse)
packages/core    src/db: Drizzle schema (users, cairns + RLS policy), createDb(), withUser(); src/users.ts (upsertGoogleUser, getUser); drizzle/ SQL migrations
deploy/base      postgres/ (pgvector pg17, init-db.sh), redis/, garage/ (garage.toml, bootstrap Job)
deploy/overlays/minikube  namespace cairn, cairn-secrets from secrets.env, resource limits
scripts/infra-forward.sh  port-forwards with auto-retry
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
- psql is not installed on WSL; use `kubectl --context cairn -n cairn exec -it postgres-0 -- psql -U postgres cairn`.

## Commands

```bash
pnpm infra:up       # deploy postgres, redis, garage to minikube (context cairn)
pnpm infra:forward  # separate terminal
pnpm install
pnpm db:migrate     # after schema changes: pnpm db:generate --name <what>
pnpm dev            # api :3000 + web :5173
pnpm lint && pnpm typecheck && pnpm format:check && pnpm build
```

## Later phases

See the Scope section of DESIGN.md: Phase 2 ingest (llm-kit v0.2: `embed()`, `stream()`), Phase 3 query, Phase 4 sharing.
