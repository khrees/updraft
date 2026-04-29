import type { DeploymentRepository } from '../db/repository.js';

export interface PipelineQueue {
  enqueue(deploymentId: string): void;
  size(): number;
  drain(): Promise<void>;
  stop(): void;
}

export type RunFn = (deploymentId: string) => Promise<void>;

export interface QueueDeps {
  deployments: DeploymentRepository;
  concurrency?: number;
  pollIntervalMs?: number;
}

export function createPipelineQueue(
  deps: QueueDeps,
  run: RunFn,
): PipelineQueue {
  const pending: string[] = [];
  const active = new Set<Promise<void>>();
  let stopped = false;
  const concurrency = deps.concurrency ?? 1;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  const tick = (): void => {
    if (stopped || active.size >= concurrency) return;

    const next = pending.shift();
    const claimed = next === undefined
      ? deps.deployments.claim()
      : deps.deployments.claimById(next);

    if (!claimed) {
      if (next === undefined && active.size === 0) {
        // Nothing pending and nothing running — poll for DB-queued work.
        setTimeout(tick, pollIntervalMs);
      } else if (next !== undefined) {
        // claimById returned null (race); try again immediately.
        tick();
      }
      return;
    }

    const promise = run(claimed.id)
      .catch((err) => {
        console.error(`pipeline run failed for ${claimed.id}:`, err);
      })
      .finally(() => {
        active.delete(promise);
        tick();
      });

    active.add(promise);

    // Fill remaining concurrency slots immediately.
    if (active.size < concurrency && (pending.length > 0)) tick();
  };

  return {
    enqueue(deploymentId) {
      if (!pending.includes(deploymentId)) pending.push(deploymentId);
      tick();
    },
    size() {
      return pending.length + active.size;
    },
    async drain() {
      while (active.size > 0 || pending.length > 0) {
        if (active.size > 0) {
          await Promise.race(active);
        } else {
          // pending has items but tick() hasn't created a slot yet.
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
    },
    stop() {
      stopped = true;
    },
  };
}
