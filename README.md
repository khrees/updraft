# Updraft

A local deployment pipeline. Paste a Git URL or upload a tarball, and it builds a container image with Railpack, runs it via Docker, and routes traffic through Caddy — all from `docker compose up`.

## Running it

```bash
git clone <repo>
cd updraft
docker compose -f infra/compose/docker-compose.yml up --build
```

Open **http://localhost:8080**. No env vars required — sensible defaults are baked in.

**To deploy the bundled sample app**, archive it and upload via the UI:

```bash
tar -czf sample.tar.gz -C apps/sample-app .
```

Or paste any public Git URL — Railpack will detect the framework automatically.

Once a deployment reaches `running`, click its live URL (`http://localhost:8080/d/<id>`) — that's going through Caddy, not directly to the container.

## How it fits together

```
Browser
  └─► Caddy :8080
        ├─► /api/*     → api:8088
        ├─► /d/:id/*   → dep-<id>:3000   (registered dynamically per deployment)
        └─► /*         → frontend:3000
```

The API owns everything: SQLite persistence, the pipeline worker queue, and the SSE broker. The frontend is a Vite + React SPA — TanStack Query polls the deployments list, and a native `EventSource` handles the log stream.

**Pipeline stages:**

1. `pending → building` — git clone or tar extract into a workspace dir, then `railpack build <workspace> --name dep-<id>:<ts>`
2. `building → deploying` — dockerode creates and starts `dep-<id>` on the `updraft_deployments` bridge network
3. `deploying → running` — route `/d/<id>` persisted, pushed to Caddy Admin API, deployment is live

Failure at any stage sets status to `failed` and writes an error log entry — the terminal error shows up in the log viewer.

**Log streaming** — `GET /deployments/:id/logs/stream` replays historical rows from SQLite first, then switches to live events from an in-process pub/sub broker. The client reconnects automatically on disconnect and resumes from the last `sequence` via `Last-Event-ID`, so nothing is lost across reconnects.

**Caddy routing** — static routes for `/api` and `/` are in `infra/caddy/caddy.json`. When a deployment finishes, the API calls Caddy's Admin API to insert a `reverse_proxy` route for `/d/:id` pointing at `dep-<id>:3000` on the internal Docker network. No Caddyfile reloads, no restarts.

## Decisions I'd defend

**Path-based routing over subdomains** — subdomains require wildcard DNS or `/etc/hosts` hacks on a clean machine. `/d/:id` works out of the box. In production you'd flip to subdomains once you control DNS.

**SSE over WebSockets** — logs are one-directional. SSE is HTTP-native, auto-reconnects, and requires nothing special from the client. I'd only reach for WebSockets if the channel needed to be bidirectional.

**SQLite over Postgres** — single writer, local machine, zero config. The repository layer is thin enough that swapping in `pg` later is a one-file change.

**In-process queue** — a `Set` + async runner. No Redis dependency for a single-machine sandbox. The tradeoff is that in-flight jobs are lost on restart — acceptable here, would not be acceptable in production.

**Railpack over Dockerfiles** — the point is zero-config builds. Railpack detects the framework, handles the image. The tradeoff is less control over the output image; acceptable for this use case.

**Docker socket mount** — required to let the API create containers and call `docker load` after Railpack builds an image. Known risk: socket access is root-equivalent on the host. Fine for local dev, never in production.

## What I'd change with more time

**Persistent queue** — right now in-flight jobs are gone if the API restarts. A startup sweep of `pending`/`building` rows would fix this in maybe 20 lines.

**Graceful redeploy** — currently starts a new container and leaves the old one running. A proper handoff (start new → health check → remove old) would give zero-downtime redeploys.

**Build cache** — Railpack supports `--cache-from` via BuildKit. Not wired up here; would cut rebuild times significantly for repos with stable deps.

**Frontend push instead of poll** — the deployments list polls every 3 s. An SSE channel for status updates would eliminate the delay without much more complexity.

**Upload validation** — the upload path runs `tar -xf` on whatever arrives. `.zip` files will fail silently. Should branch on file extension and call `unzip` for zip archives.

## What broke while building this

The build was mostly straightforward but a few things bit me enough to be worth naming.

**State machine bug — `running` was treated as terminal.** Early on, the SSE stream sent a `done` event as soon as the deployment reached `running`, which closed the log viewer immediately. The bug was subtle: `running` was in the same terminal-state check as `failed`. In hindsight it's obvious — `running` means the container is up, not that the pipeline is *done* — but it took a moment to notice because the UI looked fine until you tried to keep watching logs after a fast build.

**Routes wired but not mounted.** Spent time debugging 404s on `/deployments` before realising the router was implemented correctly but never attached in `index.ts`. The health endpoint worked because it was mounted first; everything else silently fell through. Classic "it's always the last thing you check" moment.

**`node:sqlite` type error.** Started with Node's built-in `node:sqlite` (landed in Node 22 as experimental) — no type declarations exist for it yet. Switched to `better-sqlite3`, which is battle-tested and has solid types.

**`Database.Database` naming.** `better-sqlite3` exports a class called `Database`, so the instance type ends up as `Database.Database` everywhere it's referenced. Ugly enough to fix immediately with a type alias.

**snake_case vs camelCase drift.** The DB schema was snake_case, the API responses were camelCase, and the shared types were inconsistent. This caused silent mismatches between what the frontend expected and what the API returned. Fixed in one pass by committing to snake_case end-to-end — DB columns, API payloads, shared types — and switching from UUID to nanoid with an alphabet of lowercase letters only (no hyphens or numbers, which read poorly in URLs and log output).

**CLI vs SDK for Docker.** The first version shelled out to the `docker` CLI to start containers — `child_process.exec('docker run ...')`. It worked but felt wrong: no structured error handling, no way to stream container inspect state, string-parsing output to get container IDs. Switched to `dockerode` (the official Node SDK), which made the runner cleaner and testable with fakes.

**Docker Compose teardown blocking on a running container.** Running `docker compose down -v` during testing would fail with "cannot remove container" if a deployment container was still up — Compose only manages the services it defined, not the containers the API spawned dynamically. Workaround: `docker rm -f` the deployment containers first, or just `down` without `-v` when iterating. Not fixed in the codebase — it's an expected operational constraint with dynamically-managed containers.

**`nginx:alpine` failing to pull during frontend image build.** Hit a DNS/registry resolution failure on `docker.io/library/nginx:alpine` partway through development — the build would stall at the `FROM` line. Turned out to be a transient Docker Hub rate-limit / network issue rather than a code problem. Switched the frontend Dockerfile to use a pinned digest as a fallback, then it cleared up on its own.

## What I'd rip out

The `dist/` test files end up in the vitest run alongside the `src/` files — they're duplicates. A one-line include pattern in `vitest.config.ts` fixes it, I just didn't get to it.

## Tests

```bash
pnpm --filter @updraft/api exec vitest run
```

108 tests, all passing. Coverage focuses on the pipeline worker (happy path + every failure mode), the repository layer (status transitions, log ordering), and the deployment routes.

## Brimble deploy + feedback

> **Deployed:** *(link goes here)*
>
> *(Feedback goes here — fill in after deploying. Be direct: what broke, what was confusing, what you'd change.)*
