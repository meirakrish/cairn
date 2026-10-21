# Cairn

Knowledge bases ("cairns") built from your documents, queryable and shareable in **cited** mode (answers link their sources) or **sealed** mode (answers only, sources not shown).

- Design: [DESIGN.md](DESIGN.md)
- Progress and next steps: [ROADMAP.md](ROADMAP.md)

## Layout

```
apps/web         SvelteKit UI (static SPA)
apps/api         Express API
apps/worker      ingest worker (BullMQ): extract → chunk → embed → store
packages/core    domain services and database schema
packages/shared  zod schemas and types shared by web and api
deploy/          Kustomize: base + minikube overlay
scripts/         dev helpers
```

## Prerequisites

- WSL2 (or Linux) with Node 22.18+, pnpm 12, Docker, minikube, kubectl

## Dev setup

Apps run on WSL with `pnpm dev`; Postgres (pgvector), Redis and Garage (S3-compatible storage) run in minikube. Ollama runs on the Windows host (see [Ollama](#ollama)).

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
| `pnpm dev`           | Run api, web and worker in watch mode                             |
| `pnpm build`         | Build all packages                                                |
| `pnpm lint`          | ESLint                                                            |
| `pnpm typecheck`     | TypeScript and svelte-check                                       |
| `pnpm format`        | Prettier (`format:check` to verify only)                          |
| `pnpm test`          | Vitest: core and api against `cairn_test` (needs `infra:forward`) |
| `pnpm eval`          | Retrieval eval: recall@k and MRR on a fixed corpus (needs Ollama) |
| `pnpm db:generate`   | Generate a SQL migration from the Drizzle schema                  |
| `pnpm db:migrate`    | Apply pending migrations as `postgres`                            |
| `pnpm infra:up`      | Apply the minikube overlay                                        |
| `pnpm infra:status`  | Show pods, volumes and jobs                                       |
| `pnpm infra:forward` | Port-forward Postgres, Redis and Garage to localhost              |
| `pnpm infra:reset`   | Delete everything in the `cairn` namespace, **including data**    |

The `infra:*` scripts use the kubectl context `cairn`; override with `KUBE_CONTEXT=<name>`. To pause the cluster and keep data, run `minikube stop -p cairn`.

## Ollama

The worker embeds chunks with Ollama on the Windows host, through [llm-kit](https://github.com/meirakrish/llm-kit).

1. On Windows: install Ollama, set the user environment variable `OLLAMA_HOST=0.0.0.0` (so WSL can reach it), restart Ollama, and pull the models:

   ```powershell
   ollama pull qwen3-embedding:0.6b
   ollama pull qwen3.5:9b
   ```

2. Allow it through the Windows firewall for WSL only. Windows creates `ollama.exe` rules on first run; narrow them in an admin PowerShell:

   ```powershell
   Get-NetFirewallRule -DisplayName "ollama.exe" | Set-NetFirewallRule -EdgeTraversalPolicy Block -RemoteAddress 172.16.0.0/12
   ```

3. In `.env`, point `OLLAMA_HOST` at the Windows host as WSL sees it (`ip route | awk '/default/ {print $3}'`), e.g. `http://172.19.208.1:11434`. The address can change after a Windows restart.

`qwen3-embedding:0.6b` makes 1024-dimension vectors (`EMBED_DIMENSIONS=1024`, fixed by the `chunks.embedding` column). The chat model is for Phase 3.

## Ingest

Uploads are processed by `apps/worker`:

1. The api stores the file and queues a BullMQ job `{ sourceId, userId }`.
2. The worker runs it as the uploader (RLS applies): extract text (text, Markdown by heading, PDF by page), split into ~600-token chunks (2400 characters, ~360 overlapping, cut at paragraph, sentence or word boundaries), embed, and store, setting the source `ready`.
3. A problem with the file (no text, damaged PDF, too much text) fails the source at once with a message for the user. Other errors (Ollama down, ...) are retried 3 times with backoff before the source is marked `failed`.

Status changes reach the browser live: `SourceService` reports every committed change, the api and the worker publish it on the Redis channel `cairn:<id>:events`, and `GET /api/cairns/:id/events` streams it (SSE). The stream opens with a snapshot of the cairn's sources (taken after subscribing, so nothing is lost in between) and re-checks the session and the cairn every 25 s, ending when either is gone. A user may hold 3 streams at once (`SSE_MAX_STREAMS_PER_USER`); a fourth gets 429 until a tab closes. Slots are Redis leases renewed on each heartbeat, so a crashed api can't hold them.

Limits: 2,000 PDF pages, 2M characters, 60 s to read a PDF. Scanned PDFs (no text layer) are not supported yet.

## Database roles

- `cairn_app`: what the api uses (`DATABASE_URL`). Not a superuser and cannot bypass row-level security.
- `postgres`: owns the tables and runs migrations (`DATABASE_ADMIN_URL`).

## Schema changes

Edit `packages/core/src/db/schema.ts`, run `pnpm db:generate --name <what>`, review the SQL in `packages/core/drizzle/`, then `pnpm db:migrate`. RLS policies are declared in the schema with `pgPolicy`. Queries that touch RLS tables go through `withUser(db, userId, tx => …)`, which sets `app.user_id` for that transaction.

## Auth

Google sign-in is handled entirely by the api (authorization code flow with PKCE, state and nonce):

- `GET /api/auth/google/start` → redirects to Google (optional `?returnTo=/path`: a same-site path, not under `/api`, to land on after signing in); `GET /api/auth/google/callback` verifies the ID token, upserts the user and sets the `cairn_sid` cookie (httpOnly, `SameSite=Lax`, 14 days).
- `GET /api/auth/me` → the current user, or 401. `POST /api/auth/logout` → ends the session.
- Sessions live in Redis under `session:<sha256(sid)>`. Mutating requests must send `Origin: $APP_ORIGIN`.

## API

All routes are under `/api` and return JSON. Errors are `{ "error": "..." }`; validation errors (400) also carry `issues`.

| Route                                      | Auth | What it does                                                                                                              |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                          | no   | Liveness                                                                                                                  |
| `GET /api/auth/me`                         | yes  | Current user                                                                                                              |
| `POST /api/auth/logout`                    | yes  | End the session                                                                                                           |
| `GET /api/cairns`                          | yes  | Your cairns and those shared with you, newest first, each with your `role` and `visibility`                               |
| `POST /api/cairns`                         | yes  | Create a cairn: `{ name, description? }` → 201                                                                            |
| `GET /api/cairns/:id`                      | yes  | One cairn                                                                                                                 |
| `GET /api/cairns/:id/sources`              | yes  | The cairn's sources (files), newest first, with status                                                                    |
| `POST /api/cairns/:id/sources`             | yes  | Upload one file (multipart field `file`, 25 MB max) → 202, processed async                                                |
| `DELETE /api/cairns/:id/sources/:sourceId` | yes  | Delete a source, its chunks and its stored file → 204                                                                     |
| `GET /api/cairns/:id/events`               | yes  | Live source updates (Server-Sent Events): a snapshot, then each change                                                    |
| `POST /api/cairns/:id/query`               | yes  | Ask a question `{ question }` (≤ 1,000 chars, 20/min): the answer as SSE — passages, text pieces, then cited numbers      |
| `GET /api/cairns/:id/shares`               | yes  | The cairn's live shares, with who opened each link (owner only)                                                           |
| `POST /api/cairns/:id/shares`              | yes  | Share: `{ kind: 'email', email, role, visibility, expiresAt? }` or `{ kind: 'link', … }` → 201; links return `token` once |
| `DELETE /api/cairns/:id/shares/:shareId`   | yes  | Revoke a share → 204 (owner only)                                                                                         |
| `POST /api/share-links/:token/redeem`      | yes  | Open a share link → `{ cairnId }`; unknown, revoked or expired links are 404                                              |

Request and response shapes are the zod schemas in `packages/shared`. Unknown, malformed or other users' ids are all 404.

Uploads accept text, Markdown and PDF. The type comes from the file's bytes (a PDF signature, otherwise valid UTF-8 text; `.md`/`.markdown` makes it Markdown), not from the browser's Content-Type. Anything else is 415, too large is 413.

## Sharing

A cairn is shared with a Google account by email, or by a link that the recipient opens while signed in. A share has a `role` (`viewer` asks questions, `editor` also adds sources) and a `visibility` (`cited` shows sources, `sealed` hides them; editors are always cited). Only the owner manages shares, deletes sources or changes the cairn. Revoking or expiring a share ends access at once. The database decides access: `cairn_access()` (used by RLS and by `ShareService.access`) returns the caller's best active grant.

Sealed callers get 403 on the source list, uploads/deletes and the events stream. Their questions are answered as `SealedAnswerEvent`s (text and `done` only): the prompt has no file names or locations and asks the model not to quote or cite, and any run of 12 words copied from a passage is replaced with "…" before it is sent. Questions are rate-limited per user (`QUERY_RATE_LIMIT`) and, through a share, per share across everyone using it (`SHARE_QUERY_RATE_LIMIT`, default 60/min).

## Tests

`pnpm test` runs Vitest over `packages/core`, `apps/api` and `apps/worker` against real Postgres and Redis, using the root `.env` connection settings but a separate `cairn_test` database and Redis db 15, so dev data is untouched. A global setup creates the database (and the `cairn_app` role, if missing), then applies migrations. Each test truncates all tables and flushes the Redis db.

- `packages/core`: `CairnService`, user upsert, and RLS isolation (cross-user reads, writes, spoofed owners, no user set).
- `apps/api`: supertest over the real app: sessions, logout, Origin check, the Google callback (Google's token exchange and ID token check are mocked), and `/api/cairns`.

- `apps/worker`: the job processor's error handling (fail at once vs. retry, user-facing messages).
- Ingest (core): chunking, extraction (PDFs built by `makePdf()`), and the pipeline with `fakeEmbedder` from llm-kit.

Helpers live in `@cairn/core/testing` and `apps/api/src/testing.ts`.

CI (`.github/workflows/ci.yml`) runs the same checks, currently by hand only (Actions tab → CI → Run workflow), with Postgres (pgvector) and Redis as service containers, plus a `kubectl kustomize` build of the minikube overlay.

## Answers

`POST /api/cairns/:id/query` retrieves the 8 best passages (hybrid search, see below), sends them to the chat model (`LLM_MODEL`, default `qwen3.5:9b`, thinking off) numbered inside `<passages>`, and streams the answer. The model is told to answer only from the passages, cite them as `[n]`, say when the documents don't contain the answer, and ignore instructions inside passages. The stream (SSE `data:` lines, `AnswerEvent` in `packages/shared`) is:

1. `passages`: the numbered passages (file, location, text), so the UI can show what `[n]` refers to;
2. `delta`: pieces of the answer as the model writes them;
3. `done`: the passage numbers the answer cited, and the latency; or `error` if the model failed midway.

Validation, access and the rate limit (`QUERY_RATE_LIMIT`, default 20 per minute per user) are checked first and return plain JSON errors. Closing the connection cancels the model call. Each completed question is logged in `query_log`.

The api asks Ollama at startup whether the model can think, to turn thinking off: start Ollama before the api, or restart the api after.

## Retrieval eval

`pnpm eval` measures how well search finds the right passages. It ingests the fixed corpus in `packages/eval/corpus/` (the US Constitution as a PDF, Strunk's _The Elements of Style_, and frozen copies of DESIGN.md and llm-kit's README) into its own database `cairn_eval` with the real embedder, then asks the 28 questions in `packages/eval/questions.json` under several search settings.

A question counts as answered at rank r when a chunk at rank r of the expected source contains the expected phrase. The run prints recall@1/3/8 and MRR per setting (and per question style: direct, paraphrase, exact) plus each question's rank, and writes `packages/eval/results/latest.json` (gitignored). Recall@8 matters most, since the top 8 chunks are what the model reads.

Run it after any change to chunking, embedding or search. Results vary by about one question between runs (random chunk ids break ties; HNSW is approximate). Don't edit the corpus or questions to make a run pass; add questions instead.
