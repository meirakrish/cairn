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

3. Deploy the infrastructure and wait for it. A one-off Job sets up Garage (layout, access key, `cairn` bucket):

   ```bash
   pnpm infra:up
   pnpm infra:status
   ```

4. In a separate terminal, forward the services to localhost (Postgres :5432, Redis :6379, Garage S3 :3900):

   ```bash
   pnpm infra:forward
   ```

5. Install and run the apps (api on :3000, web on http://localhost:5173, which proxies `/api` to the api):

   ```bash
   pnpm install
   pnpm dev
   ```

## Commands

| Command              | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `pnpm dev`           | Run api and web in watch mode                                  |
| `pnpm build`         | Build all packages                                             |
| `pnpm lint`          | ESLint                                                         |
| `pnpm typecheck`     | TypeScript and svelte-check                                    |
| `pnpm format`        | Prettier (`format:check` to verify only)                       |
| `pnpm infra:up`      | Apply the minikube overlay                                     |
| `pnpm infra:status`  | Show pods, volumes and jobs                                    |
| `pnpm infra:forward` | Port-forward Postgres, Redis and Garage to localhost           |
| `pnpm infra:reset`   | Delete everything in the `cairn` namespace, **including data** |

The `infra:*` scripts use the kubectl context `cairn`; override with `KUBE_CONTEXT=<name>`. To pause the cluster and keep data, run `minikube stop -p cairn`.

## Database roles

- `cairn_app`: what the api uses (`DATABASE_URL`). Not a superuser and cannot bypass row-level security.
- `postgres`: owns the tables and runs migrations (`DATABASE_ADMIN_URL`).
