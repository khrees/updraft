# Updraft

Paste a Git URL or drop a project folder into the UI. Updraft builds a container image with Railpack, runs it in Docker, and routes traffic through Caddy. The whole thing comes up with one command.

```bash
git clone <repo>
cd updraft
docker compose up --build
```

Open **http://localhost:8081**. No env vars needed — sensible defaults are baked in. To try it immediately, use the Upload tab and select `apps/sample-app/` — the browser packages it into a tar archive client-side, no manual steps required. Or paste any public Git URL; Railpack detects the framework automatically.

---

## How the pieces fit together

```
Browser
  └─► Caddy :8081
        ├─► /api/*      → Hono API :8088
        ├─► /d/:id/*    → dep-<id>:3000   (injected per deployment)
        └─► /*          → Vite frontend :3000
```

Caddy is the only thing exposed to the outside. Three services sit behind it: the frontend SPA, the API, and the deployment containers themselves. The API is the only stateful piece — it owns the SQLite database, the pipeline job queue, and the SSE broker. The frontend is a thin React shell; it polls the deployments list with TanStack Query and opens a native `EventSource` for log streaming.

**The pipeline runs in three stages:**

1. **Source** — git clone or tar extract into a workspace directory.
2. **Build** — `railpack build <workspace> --name dep-<id>:<ts>`. Railpack detects the framework, builds the image, imports it into the local Docker daemon via BuildKit. A BuildKit sidecar runs as a service in the compose stack; Railpack finds it via `BUILDKIT_HOST`.
3. **Deploy** — a new container starts under a timestamped revision name, gets health-checked until it responds over HTTP, then gets renamed to the stable slot (`dep-<id>`). Caddy routes by container name on the internal Docker network, so the rename is the cutover. The old container drains in the background. Once the container is live, the API calls Caddy's Admin API to register a `/d/:id` route — no config file reload, no restart.

**Status flow:** `pending → building → deploying → running`. Any non-terminal state can become `failed` or `cancelled`. The UI surfaces a Cancel button for in-progress deployments and a Retry button for failed ones.

**Log streaming** works over SSE. The stream replays historical rows from SQLite first, then switches to an in-process pub/sub broker for live events. If the client disconnects and reconnects, it sends `Last-Event-ID` (or `?afterSequence=`) and gets exactly the missed events — nothing replayed, nothing skipped.

**Caddy route durability** — dynamic routes live in Caddy's memory. A restart wipes them. On API startup, Updraft re-registers routes for every deployment in `running` state, so a compose restart doesn't orphan live containers. Routes are inserted dynamically before the frontend catch-all: the registrar reads the live Caddy config, finds the `frontend-route` by `@id`, and inserts at that index. This means the order stays correct regardless of how many deployment routes have accumulated.

**Build cache** — each source gets a stable cache key (16-char SHA-256 of `source_type:source_ref`). On repeat builds, Railpack receives `--cache-from` pointing at the prior BuildKit cache, and always writes back with `--cache-to`. The `build_cache` table in SQLite tracks key, ref, hit count, and last used time.

**Redeploy and rollback** — every successful Railpack build is recorded in `deployment_builds`. You can queue a new deployment against a prior image tag; the pipeline skips Railpack entirely and goes straight to the run step. The log viewer surfaces the build history and exposes Redeploy / Rollback buttons for each prior tag.

---

## API

All routes are under `/api`. Caddy strips the prefix before forwarding to the API on `:8088`.

Every response uses the same envelope:

```json
{ "success": true, "message": "...", "data": <payload> }
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check |
| `POST` | `/api/deployments` | Create and enqueue a deployment |
| `GET` | `/api/deployments` | List all deployments, newest first |
| `GET` | `/api/deployments/:id` | Get one deployment |
| `GET` | `/api/deployments/:id/builds` | Build history for this source |
| `POST` | `/api/deployments/:id/cancel` | Cancel a non-terminal deployment |
| `POST` | `/api/deployments/:id/retry` | Re-queue a failed deployment from scratch |
| `POST` | `/api/deployments/:id/redeploy` | Deploy a prior image tag (skips Railpack) |
| `POST` | `/api/deployments/:id/rollback` | Same as redeploy — different intent, same mechanics |
| `GET` | `/api/deployments/:id/logs/stream` | SSE log stream |

**Creating a deployment** — two shapes:

```
# Git URL
Content-Type: application/json
{ "git_url": "https://github.com/user/repo" }

# Folder upload
Content-Type: multipart/form-data
archive=<tar file>
```

**Log stream events:**

| Event | Payload |
|-------|---------|
| `log` | `{ id, deployment_id, stage, message, timestamp, sequence }` |
| `status` | `{ deployment_id, status }` |
| `done` | `{ status }` — terminal, client should close |

**Core types:**

```typescript
type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'cancelled';

interface Deployment {
  id: string;
  source_type: 'git' | 'upload';
  source_ref: string;           // git URL or upload filename
  status: DeploymentStatus;
  image_tag?: string;           // set once Railpack finishes
  container_name?: string;      // dep-<id> — the stable name Caddy routes to
  route_path?: string;          // /d/<id>
  live_url?: string;            // http://localhost:8081/d/<id>
  created_at: string;
  updated_at: string;
}
```

---

## Environment variables

Everything has a default. Nothing needs to be set to run locally.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `8088` | API listen port |
| `DB_PATH` | `/data/updraft.db` | SQLite file |
| `PUBLIC_BASE_URL` | `http://localhost:8081` | Used to construct `live_url` |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy Admin API |
| `DEPLOYMENT_NETWORK` | `updraft_deployments` | Docker network for deployed containers |
| `APP_INTERNAL_PORT` | `3000` | Port deployed containers must listen on |
| `UPLOAD_DIR` | `<cwd>/data/uploads` | Where uploaded archives land |
| `WORKSPACE_ROOT` | `/app/workspaces` | Where source is extracted before building |
| `BUILDKIT_HOST` | `docker-container://updraft-buildkit-1` | BuildKit gRPC target for Railpack |
| `BUILD_CACHE_DIR` | `/tmp/updraft-cache` | Local BuildKit layer cache |
| `BUILD_CACHE_REGISTRY` | unset | Set to use a registry for cache instead |
| `DRAIN_TIMEOUT_MS` | `10000` | Grace period before SIGKILL on old container |

---

## Repo layout

```
apps/
  api/          Hono API — pipeline, SQLite, SSE broker
  frontend/     Vite + React — TanStack Router + Query
  sample-app/   Plain Node.js server for testing deployments
packages/
  shared-types/ TypeScript types shared across API and frontend
infra/
  caddy/        caddy.json — static routes (api + frontend catch-all)
docker-compose.yml
```

---

## Decisions

**Path-based routing, not subdomains.** Subdomain routing requires wildcard DNS or `/etc/hosts` edits on a reviewer's machine. `/d/:id` works out of the box. You'd flip to subdomains in production once you control DNS.

**SSE, not WebSockets.** Logs flow one direction. SSE is HTTP-native, reconnects automatically, and the `Last-Event-ID` resume mechanism is part of the spec — no custom protocol needed. WebSockets would add complexity for no benefit here.

**SQLite, not Postgres.** Single writer, single machine, zero config. The repository layer (`db/repository.ts`) is thin enough that swapping in `pg` is a one-file change.

**In-process queue, not Redis.** A `Set` plus an async runner. No external dependency for a single-machine sandbox. The known tradeoff — in-flight jobs lost on restart — is documented and acceptable here. In production you'd want a persistent queue and a startup sweep of `pending`/`building` rows.

**Railpack, not Dockerfiles.** The whole point is zero-config builds. Railpack detects the framework and handles the image. You give up control over the output image; that's acceptable for this use case.

**Docker socket mount.** Railpack needs it (it communicates with BuildKit over gRPC via the socket), and dockerode needs it to manage containers. Root-equivalent on the host — fine for local dev, never in production.

**Dockerode, not `child_process`.** The first version shelled out to `docker run`. No structured errors, no clean way to stream inspect state, string-parsing to get container IDs. Dockerode made the runner testable with dependency injection and gave proper typed errors.

---

## What broke

**Caddy routes lost on restart.** Dynamic routes live in Caddy's memory. A restart wipes them, making running containers unreachable. Fixed by re-registering all `running` routes at API startup, with idempotent insert (delete-then-insert at the correct index derived from the live config).

**Absolute asset paths in deployed apps.** Railpack-built Vite/Bun apps default to `base: "/"`, so `<script src="/assets/app.js">` hits the frontend SPA instead of the container. Fixed by injecting `<base href="/d/:id/">` into HTML responses via Caddy's `replace_response` handler.

**`running` treated as terminal in SSE stream.** The log viewer closed immediately when a deployment hit `running` because it shared a terminal-state check with `failed`. Fixed by separating "pipeline done" (`failed`/`cancelled`) from "container is up" (`running`).

**snake_case vs camelCase drift.** DB columns were snake_case, API responses camelCase, shared types inconsistent — silent mismatches throughout. Fixed in one pass: snake_case end-to-end across DB, API, and shared types.

**`SQLITE_BUSY` under concurrent writes.** No `busy_timeout` was set, so any write arriving while the pipeline held a transaction failed immediately. Fixed by setting `busy_timeout = 5000` and disabling auto-checkpoint in favour of an explicit WAL truncation on graceful shutdown.

**Stuck deployments after API restart.** In-flight `building`/`deploying` deployments stayed stuck forever if the process died mid-pipeline. Fixed by forcing them to `failed` at startup so they can be retried.

**`node:sqlite` type error.** Node 22's built-in `node:sqlite` is experimental with no type declarations. Switched to `better-sqlite3`.

**Docker Compose teardown blocking.** `docker compose down -v` fails if deployment containers are still running — Compose only manages what it defined. Workaround: `docker rm -f` those containers first.

---

## What I learned

**SQLite is production-ready if you configure it.** WAL mode + `busy_timeout` + explicit checkpointing handles real concurrent write pressure without any queue or connection pool. The defaults (`busy_timeout = 0`, auto-checkpoint) are wrong for a server — you have to opt in to the good behaviour.

**Reliability gaps only show up under restarts.** The pipeline logic was correct in isolation, but a process crash mid-build left deployments stuck forever with no recovery path. Stateful systems need to reason about what happens when they start up cold, not just when they're running smoothly.

**Path traversal is easy to introduce and easy to miss.** Using `archive.name` directly from a user upload to construct a file path felt natural in the moment — the bug isn't obvious until you think about what a malicious client would send. Input sanitisation at the boundary (`path.basename` + allowlist + resolved-path check) has to be deliberate.

**Non-atomic DB patterns look fine until they're not.** The check-then-insert pattern in `buildCache.upsert` and `builds.record` would work correctly 99.9% of the time in local dev, then blow up under concurrent builds in production. SQLite has `INSERT OR IGNORE` and `ON CONFLICT DO UPDATE` — use them.

**Serial queues are the safe default, but the wrong default.** A single-slot pipeline queue is easy to reason about and easy to test, but it means every deployment waits for every other one. Switching to a concurrency-limited pool (`active: Set<Promise>`) was about 30 lines and the behaviour is strictly better.

**SSE is underrated.** Native browser reconnect with `Last-Event-ID`, no protocol overhead, works through every proxy. For one-directional server-to-client streams it's a better fit than WebSockets and simpler to implement correctly.

**Caddy's Admin API makes dynamic routing practical.** No config reloads, no restarts — just `PUT /config/...` and the route is live instantly. The tricky part is that routes live in memory, which means startup recovery is a first-class concern, not an afterthought.

---

## What I'd change with more time

**Push instead of poll for deployment status.** The list polls every 3 s. An SSE channel for the list would remove the delay and the unnecessary requests.

**Upload validation.** The API accepts whatever arrives in the `archive` field and runs `tar -xf` on it. A direct API call with a non-tar body fails silently. Should validate content type at the boundary.

**Cache eviction.** The `build_cache` table grows unboundedly. An LRU sweep on `last_used_at` would keep disk usage bounded.

---

## Tests

```bash
pnpm --filter @updraft/api exec vitest run
```

71 tests, all passing. Coverage: pipeline worker (happy path and every failure mode), repository layer (status transitions, log ordering), deployment routes, build cache, and zero-downtime container handoff.

---

## Brimble deploy + feedback

**Deployed:** https://updraft.brimble.app/

The frontend is deployed as a static SPA. Settings used:

| Setting | Value |
|---|---|
| Install command | `pnpm install` |
| Build command | `pnpm build:brimble` |
| Output directory | `public` |

`pnpm build:brimble` builds the frontend with Vite and copies `dist/` to `public/` at the repo root. `brimble.json` at the root handles the SPA rewrite. The Vite config resolves `@updraft/shared-types` directly from TypeScript source via a `resolve.alias`, so there's no need to pre-build the package before the frontend build.

**Feedback:**

The deploy went smoothly — Vite was auto-detected (it defaulted to Node.js first, switched manually), build passed on the first try, and `brimble.json` was picked up without any configuration. No friction getting it live.

The friction came after. The free plan is static only, so the deployed app immediately shows a raw JSON parse error on load — `Unexpected token '<'` — because the API call gets back a Brimble 404 HTML page. There's no indication in the deploy UI that backend routes won't work on the free tier, no upgrade prompt, nothing. You just get a confusing error in the browser. A simple callout — "API routes require a paid plan" — would save a lot of head-scratching.

The docs have no coverage of monorepo setups. I had to guess that `pnpm install` at the repo root was the right install command, and that `pnpm build:brimble` from root would resolve the workspace dependency correctly. The import UI exposes the right fields but gives no guidance on what to put in them for a pnpm workspace. A single example would fix this.
