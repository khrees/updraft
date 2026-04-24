import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createDeploymentRepository, createLogRepository } from '../db/repository.js';
import { runPipeline } from './worker.js';
import type { SourceAcquirer } from './sources.js';
import type { Builder } from './build.js';
import type { SSEMessage } from '@updraft/shared-types';
import { BuildFailedError, SourceAcquisitionError } from '../lib/errors.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function fakeAcquirer(workspacePath = '/tmp/ws'): SourceAcquirer {
  return {
    async acquire({ logger }) {
      await logger.log('cloned');
      return { workspacePath };
    },
  };
}

function failingAcquirer(): SourceAcquirer {
  return {
    async acquire() {
      throw new SourceAcquisitionError('boom');
    },
  };
}

function fakeBuilder(image_tag = 'dep-x:1'): Builder {
  return {
    async build({ logger }) {
      await logger.log('built');
      return { image_tag };
    },
  };
}

function failingBuilder(): Builder {
  return {
    async build() {
      throw new BuildFailedError('build broke');
    },
  };
}

describe('runPipeline', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('runs the happy path: status -> building, persists logs and image_tag', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const messages: SSEMessage[] = [];
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      publish: (_id, msg) => {
        messages.push(msg);
      },
      acquirer: () => fakeAcquirer(),
      builder: fakeBuilder('dep-x:42'),
    });

    const after = deployments.getById(d.id)!;
    expect(after.status).toBe('building');
    expect(after.image_tag).toBe('dep-x:42');

    const events = logs.listByDeployment(d.id);
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining(['cloned', 'built', 'Build complete: dep-x:42']),
    );
    expect(events.map((e) => e.sequence)).toEqual([...events.map((e) => e.sequence)].sort((a, b) => a - b));

    const statusEvents = messages.filter((m) => m.type === 'status');
    expect(statusEvents[0]).toEqual({ type: 'status', data: { deployment_id: d.id, status: 'building' } });
    expect(messages.filter((m) => m.type === 'log').length).toBeGreaterThanOrEqual(3);
  });

  it('marks deployment failed and emits status when source acquisition throws', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => failingAcquirer(),
      builder: fakeBuilder(),
    });

    const after = deployments.getById(d.id)!;
    expect(after.status).toBe('failed');
    const messages = logs.listByDeployment(d.id).map((e) => e.message);
    expect(messages.some((m) => m.includes('Pipeline failed'))).toBe(true);
  });

  it('marks deployment failed when the builder throws', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => fakeAcquirer(),
      builder: failingBuilder(),
    });

    expect(deployments.getById(d.id)!.status).toBe('failed');
  });

  it('does nothing if the deployment does not exist', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    await expect(
      runPipeline('missing', {
        deployments,
        logs,
        acquirer: () => fakeAcquirer(),
        builder: fakeBuilder(),
      }),
    ).resolves.toBeUndefined();
  });
});
