FROM node:20-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/frontend/package.json ./apps/frontend/

RUN pnpm install --frozen-lockfile

COPY packages/shared-types/ ./packages/shared-types/
COPY apps/frontend/ ./apps/frontend/

RUN pnpm --filter @updraft/shared-types build
RUN pnpm --filter @updraft/frontend build

FROM nginx:alpine AS runtime

COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html

# SPA routing: serve index.html for all routes
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
