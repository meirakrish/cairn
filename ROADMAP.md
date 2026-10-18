# Cairn roadmap

Working notes for picking the project up in any session. The agreed design is in [DESIGN.md](DESIGN.md); this file tracks progress against it.

## Conventions

- One branch per step: `phase<N>/step<M>-<slug>`, pushed, PR only on request.
- Update this file before every commit.

## Phase 1: foundation

| Step | What                                                                                                      | Status | Branch                  |
| ---- | --------------------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| 1    | pnpm monorepo, Prettier, ESLint, TS base config                                                           | done   | `phase1/step1-monorepo` |
| 2    | `deploy/`: Kustomize base + minikube overlay (Postgres+pgvector, Redis, MinIO), port-forward script       | next   |                         |
| 3    | `packages/core/db`: Drizzle schema + migrations for `users`, `cairns`; RLS on `cairns`                    | todo   |                         |
| 4    | Google login: server-side OIDC, Redis session, httpOnly `cairn_sid` cookie                                | todo   |                         |
| 5    | Cairns: `POST`/`GET /api/cairns` + web list/create page                                                   | todo   |                         |
| 6    | Tests (Vitest + supertest, RLS isolation) and README dev loop                                             | todo   |                         |
| 7    | CI: GitHub Actions (format, lint, typecheck, build, test with pgvector + Redis services, kustomize build) | todo   |                         |

Decisions made during planning:

- Drizzle schema and `CairnService` live in `packages/core` (the Phase 2 worker reuses them).
- Apps run on WSL with `pnpm dev`; infra in minikube reached via `kubectl port-forward` (5432, 6379, 9000/9001).
- Postgres app role is non-superuser so RLS applies; per-request `set_config('app.user_id', …, true)` in a transaction.
- CSRF: `SameSite=Lax` plus an Origin check on mutating routes.
- Web is plain CSS, no UI library.
- Dockerfiles and image builds are deferred until apps run in the cluster.

## Current layout

```
apps/web         SvelteKit 3 SPA (adapter-static, ssr=false); dev proxy /api → localhost:3000
apps/api         Express 5; dev with tsx watch, build with tsdown → dist/index.mjs
packages/shared  zod schemas/types
packages/core    stub (db + services from step 3)
```

## Gotchas

- TypeScript is pinned to `~6.0`: SvelteKit 3 requires TS 6, typescript-eslint supports `<6.1`.
- SvelteKit 3 has no `svelte.config.js`; config is in `vite.config.ts`, and `tsconfig.json` extends `$app/tsconfig`.
- pnpm 12 blocks dependency build scripts; allowed ones are listed under `allowBuilds` in `pnpm-workspace.yaml`.
- Workspace packages export TypeScript source (`./src/index.ts`); the api bundles them via `noExternal` in `tsdown.config.ts`.
- TS 6 defaults `types` to `[]`; node packages set `"types": ["node"]`.
- `DESIGN.md` is in `.prettierignore` so its tables stay as written.

## Commands

```bash
pnpm install
pnpm dev            # api :3000 + web :5173
pnpm lint && pnpm typecheck && pnpm format:check && pnpm build
```

## Later phases

See the Scope section of DESIGN.md: Phase 2 ingest (llm-kit v0.2: `embed()`, `stream()`), Phase 3 query, Phase 4 sharing.
