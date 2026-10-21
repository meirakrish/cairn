# Cairn: high-level design

Each user signs in with Google and can own many **cairns**. A cairn is a knowledge base built from uploaded documents. A cairn can be queried, and shared in one of two modes:

- **cited**: answers quote and link the sources.
- **sealed**: answers only, with no sources shown.

## Stack

| Layer         | Choice                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| Frontend      | SvelteKit (TypeScript), adapter-static, served by nginx                                      |
| Backend       | Express (TypeScript)                                                                         |
| Worker        | Ingestion jobs on BullMQ, sharing code with the API                                          |
| Database      | Postgres + pgvector (vectors, full-text search, all app data), accessed through Drizzle     |
| Queue / cache | Redis: BullMQ jobs, rate limits, caching                                                     |
| File storage  | Garage for dev, S3-compatible storage in the cloud                                            |
| LLM layer     | [`@meirakrish/llm-kit`](https://github.com/meirakrish/llm-kit), extended in v0.2 with an `Embedder`, and in v0.3 with `stream()` for Phase 3 |
| Models (dev)  | Ollama on the Windows host: `qwen3.5:9b` (chat) + `qwen3-embedding:0.6b` (embeddings)        |
| Models (cloud)| Chosen in llm-kit config. Embeddings need their own provider setting (Anthropic has no embedding API). |
| Tooling       | pnpm monorepo, Prettier, ESLint                                                              |

## Repo layout

```
apps/web         SvelteKit UI
apps/api         Express REST + SSE
apps/worker      extract → chunk → embed
packages/core    QueryService, IngestService, sharing policy (a future MCP server calls this too)
packages/shared  zod schemas and types for frontend and backend
deploy/          Kustomize (minikube overlay now, cloud overlay later)
```

## Runtime

```
browser ─► ingress ─┬─ /     → web
                    └─ /api  → api ──► Postgres · Redis · Garage
                                  └──► worker (BullMQ)
api, worker ──► llm-kit ──► Ollama (dev) / hosted provider (cloud)
```

- Web and api are separate images and deployments, routed by path on one domain. Same origin means no CORS and a simple httpOnly session cookie. Moving to `app.` / `api.` subdomains later needs only a CORS allowlist; the cookie still works with `SameSite=Lax`.
- Kubernetes-first: dev runs on minikube in WSL, production in the cloud.
- Dev loop: `pnpm dev` on WSL. Postgres, Redis and Garage run in minikube.
- Ollama runs on Windows, not in WSL or the cluster. In the cluster it is a selector-less Service `ollama` with a manual EndpointSlice pointing at the Windows host, so apps use `OLLAMA_HOST=http://ollama:11434`. Ollama on Windows needs `OLLAMA_HOST=0.0.0.0` and a firewall rule.
- Dev GPU: RTX 3060, 12 GB. The chat and embedding models must both fit fully on the GPU.

## Main flows

- **Auth**: Google OIDC handled by the server (`google-auth-library`). The session is an httpOnly cookie backed by Redis. No JWTs in localStorage.
- **Ingest**: upload (or a URL, which the worker fetches and saves as a snapshot) → original saved to Garage → BullMQ job → extract text → chunk (~600 tokens with overlap, keeping the page/section location) → embed → store in Postgres. Source status: `pending → processing → ready | failed`, sent over SSE.
- **Query**: check access and mode → hybrid search (pgvector + `tsvector`, reciprocal rank fusion) → LLM answer streamed over SSE → sharing policy applied.
- **Share**: with a Google account by email, or by a revocable link token with an optional expiry. Links need sign-in; opening one records a redemption, so access always belongs to a user. Roles are `viewer` (query) and `editor` (add sources). The owner is implicit. The mode is `cited` or `sealed`.

## Sealed mode rules

Enforced on the server, by structure first:

1. A sealed caller's response type has no citation fields.
2. Source and file endpoints return 403 for sealed callers.
3. File names and source metadata never go into the prompt for sealed queries, so injected text in a document has nothing to leak.
4. The prompt says to synthesize, not quote. A verbatim n-gram overlap check backs it up.
5. Rate limits per share, kept in Redis.

Product wording: "sources are not shown". Sealed mode hides attribution and raw text, not the information itself.

## Data model

```
users      (id, google_sub, email, name, avatar_url, created_at)
cairns     (id, owner_id, name, description, embed_model, created_at)
sources    (id, cairn_id, kind, filename, mime, storage_key, size, status, error, created_by, created_at)
chunks     (id, cairn_id, source_id, ordinal, content, location jsonb, embedding vector(N), tsv tsvector)
shares     (id, cairn_id, grantee_email?, link_token_hash?, role, visibility, expires_at, revoked_at,
            created_by, created_at)
share_redemptions (share_id, user_id, created_at)
api_keys   (id, cairn_id, share_id, hashed_key, last_used_at)
query_log  (id, cairn_id, user_id, share_id, question, chunk_count, latency_ms, created_at)
quiz_questions (id, cairn_id, chunk_id, question, choices, correct_choice, answer, explanation,
            created_by, created_at)
quiz_attempts  (id, question_id, cairn_id, user_id, choice, verdict, answered_at, created_at)
```

- Every table that holds cairn data has a `cairn_id`. Postgres Row-Level Security enforces access.
- `embed_model` is stored per cairn. Changing it means re-indexing that cairn.

## Security

- Uploaded documents are untrusted input, both for parsers and for prompt injection.
- The worker gets only the database, Redis, Garage, Ollama and outbound HTTP for web sources: no OAuth secrets.
- Web sources are fetched by the worker through `fetchUrl`, which connects only to public addresses (checked on the address actually connected to, so DNS rebinding can't slip through), on ports 80/443, re-checking every redirect. A URL must never reach Postgres, Redis, Garage, Ollama or a metadata service. Later, defense in depth: a NetworkPolicy limiting the worker's egress to public IPs.
- Web pages are untrusted input, like uploaded documents.

## Quality

- A retrieval eval set from the start: a fixed test cairn with 20–30 questions and their expected chunks, scored with recall@k on every retrieval change.

## Scope

- **Phase 1, foundation**: monorepo, Prettier, ESLint, minikube infra (Postgres + pgvector, Redis, Garage), Google login, create and list cairns.
- **Phase 2, ingest**: text, PDF and Markdown. llm-kit v0.2 (embeddings).
- **Phase 3, query**: hybrid retrieval, cited answers streamed over SSE (llm-kit `stream()`), eval set.
- **Phase 4, sharing**: email and link shares, cited and sealed.
- **Quiz**: multiple-choice questions written from passages, kept in a per-cairn bank and reused, written ahead in the background; cited callers only.
- **Moderation**: a chat model blocks clearly harmful content (sexual content, sexual content involving minors, graphic violence, hate, encouraging self-harm, instructions for serious harm) in sources, cairn names and questions; discussing those subjects is allowed. `MODERATION_ENABLED` turns it off.
- **Later**: API keys, MCP server over `packages/core`. (Images and CSV/JSON were done in Phase 5.)
