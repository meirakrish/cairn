# One file, four images: docker build --target api|worker|web|migrate .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Dependencies only, so source edits don't reinstall.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/eval/package.json packages/eval/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @cairn/api --filter @cairn/worker --filter @cairn/web build

# Production dependencies of one app (and the workspace packages it bundles).
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/eval/package.json packages/eval/
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --shamefully-hoist --filter @cairn/api... --filter @cairn/worker...

FROM node:22-slim AS api
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./node_modules
COPY --from=prod-deps /app/packages /app/packages
COPY --from=build /app/apps/api/dist ./dist
COPY apps/api/package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.mjs"]

FROM node:22-slim AS worker
ENV NODE_ENV=production
WORKDIR /app/apps/worker
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./node_modules
COPY --from=prod-deps /app/packages /app/packages
COPY --from=build /app/apps/worker/dist ./dist
COPY apps/worker/package.json ./
USER node
CMD ["node", "dist/index.mjs"]

# Applies migrations as postgres (DATABASE_ADMIN_URL), then exits.
FROM build AS migrate
CMD ["pnpm", "db:migrate"]

# Static SPA; nginx also proxies /api to the api (see deploy/docker/nginx.conf.template).
FROM nginx:1-alpine AS web
ENV API_UPSTREAM=api:3000
COPY deploy/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/build /usr/share/nginx/html
EXPOSE 80
