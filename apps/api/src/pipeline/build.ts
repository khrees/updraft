import crypto from "node:crypto";
import type { Deployment } from "@updraft/shared-types";
import { runStreaming, type SpawnOptions } from "./process.js";
import { BuildFailedError } from "../lib/errors.js";
import type { StageLogger } from "./logger.js";
import type { BuildCacheRepository } from "../db/repository.js";

const RAILPACK_PATH = process.env.RAILPACK_PATH ?? "/root/.local/bin/railpack";

export interface BuildInput {
  deployment: Deployment;
  workspacePath: string;
  logger: StageLogger;
}

export interface BuildResult {
  image_tag: string;
}

export interface Builder {
  build(input: BuildInput): Promise<BuildResult>;
}

export interface RailpackBuilderDeps {
  spawn?: SpawnOptions["spawn"];
  now?: () => Date;
  command?: string;
  timeoutMs?: number;
  cacheRepo?: BuildCacheRepository;
}

function sourceCacheKey(source_type: string, source_ref: string): string {
  return crypto
    .createHash("sha256")
    .update(`${source_type}:${source_ref}`)
    .digest("hex")
    .slice(0, 16);
}

export function createRailpackBuilder(deps: RailpackBuilderDeps = {}): Builder {
  const command = deps.command ?? RAILPACK_PATH;
  const now = deps.now ?? (() => new Date());
  const timeoutMs =
    deps.timeoutMs ?? Number(process.env["BUILD_TIMEOUT_MS"] ?? 600000);
  const cacheRepo = deps.cacheRepo;

  return {
    async build({ deployment, workspacePath, logger }) {
      const image_tag = `dep-${deployment.id}:${Math.floor(now().getTime() / 1000)}`;
      await logger.log(`Building image ${image_tag} from ${workspacePath}`);

      // B-02: build cache reuse via railpack's --cache-key flag.
      // Railpack uses the key to namespace its internal BuildKit cache layers —
      // the same key on a repeat build lets BuildKit reuse cached steps.
      const cacheKey = sourceCacheKey(
        deployment.source_type,
        deployment.source_ref,
      );
      const existingCache = cacheRepo?.get(cacheKey) ?? null;

      if (existingCache) {
        await logger.log(
          `[cache] HIT key=${cacheKey} hits=${existingCache.hit_count}`,
        );
      } else {
        await logger.log(
          `[cache] MISS key=${cacheKey} — first build for this source`,
        );
      }
      cacheRepo?.upsert(cacheKey, cacheKey);

      // --progress=plain: BuildKit's "auto" mode falls back to a TTY-style
      // renderer that buffers stderr per step, so a failing `bun install`
      // shows only the first line ("bun install v1.1.43") before the build
      // appears to hang. plain mode streams every line as it happens, which
      // is what we need for the SSE log viewer to surface real errors.
      const buildCmd = `${command} build ${workspacePath} --name ${image_tag} --cache-key ${cacheKey} --progress=plain`;

      const result = await runStreaming(
        "sh",
        ["-c", buildCmd],
        async (line) => {
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
        timeoutMs,
      );
      if (result.exitCode !== 0) {
        throw new BuildFailedError(
          `railpack build exited with code ${result.exitCode}`,
        );
      }
      return { image_tag };
    },
  };
}
