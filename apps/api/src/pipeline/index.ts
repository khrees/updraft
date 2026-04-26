import type Database from 'better-sqlite3';
import { createBuildRepository, createDeploymentRepository, createLogRepository } from '../db/repository.js';
import { createPipelineQueue, type PipelineQueue } from './queue.js';
import { runPipeline, type PipelineDeps } from './worker.js';

let _queue: PipelineQueue | null = null;

export function getPipelineQueue(db: Database.Database, overrides: Partial<PipelineDeps> = {}): PipelineQueue {
  if (_queue) return _queue;
  const deps: PipelineDeps = {
    deployments: createDeploymentRepository(db),
    logs: createLogRepository(db),
    builds: createBuildRepository(db),
    ...overrides,
  };
  _queue = createPipelineQueue(
    { deployments: deps.deployments, pollIntervalMs: 1000 },
    (id) => runPipeline(id, deps),
  );
  return _queue;
}

// test-only
export function resetPipelineQueue(): void {
  _queue?.stop();
  _queue = null;
}
