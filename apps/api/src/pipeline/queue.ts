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
  pollIntervalMs?: number;
}

export function createPipelineQueue(
  deps: QueueDeps,
  run: RunFn,
): PipelineQueue {
  const pending: string[] = [];
  let current: Promise<void> | null = null;
  let stopped = false;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  const tick = (): void => {
    if (current || stopped) return;

    let resolve!: () => void;
    current = new Promise<void>(r => (resolve = r));

    const next = pending.shift();
    const claimed = next === undefined
      ? deps.deployments.claim()
      : deps.deployments.claimById(next);

    if (claimed) {
      run(claimed.id)
        .catch((err) => {
          console.error(`pipeline run failed for ${claimed.id}:`, err);
        })
        .finally(() => {
          current = null;
          resolve();
          tick();
        });
      return;
    }

    current = null;
    resolve();

    if (next === undefined) {
      const res = resolve;
      current = null;
      res?.();
      setTimeout(tick, pollIntervalMs);
      return;
    }

    tick();
  };

  return {
    enqueue(deploymentId) {
      if (!pending.includes(deploymentId)) pending.push(deploymentId);
      tick();
    },
    size() {
      return pending.length + (current ? 1 : 0);
    },
    async drain() {
      while (current || pending.length > 0) {
        if (current) {
          await current;
        } else {
          // pending has items but tick() hasn't created `current` yet (e.g. between
          // the finally() clearing `current` and the recursive tick() running).
          // Yield to the event loop so tick() can advance before we re-check.
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
    },
    stop() {
      stopped = true;
    },
  };
}