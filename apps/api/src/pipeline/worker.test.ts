import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createDeploymentRepository, createLogRepository } from '../db/repository.js';
import { runPipeline } from './worker.js';
import type { SourceAcquirer } from './sources.js';
import type { Builder } from './build.js';
import type { Runner } from './runner.js';
import type { RouteAssigner } from './routing.js';
import type { RouteRegistrar } from './caddy.js';
import type { SSEMessage } from '@updraft/shared-types';
import { BuildFailedError, DeployFailedError, SourceAcquisitionError } from '../lib/errors.js';

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

function fakeRunner(container_id = 'c0ffee0000'): Runner {
  return {
    async run({ logger }) {
      await logger.log('container up');
      return { container_id, container_name: 'dep-x', internal_port: 3000 };
    },
  };
}

function failingRunner(): Runner {
  return {
    async run() {
      throw new DeployFailedError('run broke');
    },
  };
}

function fakeRouteAssigner(): RouteAssigner {
  return {
    assign({ deployment }) {
      return { route_path: `/d/${deployment.id}`, live_url: `http://test/d/${deployment.id}` };
    },
  };
}

function fakeRouteRegistrar(): RouteRegistrar {
  return {
    async register() {},
  };
}

describe('runPipeline', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('runs happy path through running: persists runtime metadata, route, and live_url', async () => {
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
      runner: fakeRunner('abcdef123456'),
      routeAssigner: fakeRouteAssigner(),
      routeRegistrar: fakeRouteRegistrar(),
    });

    const after = deployments.getById(d.id)!;
    expect(after.status).toBe('running');
    expect(after.image_tag).toBe('dep-x:42');
    expect(after.container_id).toBe('abcdef123456');
    expect(after.container_name).toBe('dep-x');
    expect(after.internal_port).toBe(3000);
    expect(after.route_path).toBe(`/d/${d.id}`);
    expect(after.live_url).toBe(`http://test/d/${d.id}`);

    const events = logs.listByDeployment(d.id);
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        'cloned',
        'built',
        'Build complete: dep-x:42',
        'container up',
        'Container started: abcdef123456',
        `Route assigned: http://test/d/${d.id}`,
      ]),
    );
    expect(events.map((e) => e.sequence)).toEqual([...events.map((e) => e.sequence)].sort((a, b) => a - b));

    const statusEvents = messages.filter((m) => m.type === 'status');
    expect(statusEvents.map((m) => m.type === 'status' ? m.data.status : '')).toEqual(
      ['building', 'deploying', 'running'],
    );
  });

  it('marks deployment failed and emits final system-stage error log when source acquisition throws', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => failingAcquirer(),
      builder: fakeBuilder(),
      runner: fakeRunner(),
      routeAssigner: fakeRouteAssigner(),
      routeRegistrar: fakeRouteRegistrar(),
    });

    const after = deployments.getById(d.id)!;
    expect(after.status).toBe('failed');
    const events = logs.listByDeployment(d.id);
    const terminal = events[events.length - 1]!;
    expect(terminal.stage).toBe('system');
    expect(terminal.message).toBe('system stage failed: boom');
  });

  it('marks deployment failed with build-stage error log when the builder throws', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => fakeAcquirer(),
      builder: failingBuilder(),
      runner: fakeRunner(),
      routeAssigner: fakeRouteAssigner(),
      routeRegistrar: fakeRouteRegistrar(),
    });

    expect(deployments.getById(d.id)!.status).toBe('failed');
    const events = logs.listByDeployment(d.id);
    const terminal = events[events.length - 1]!;
    expect(terminal.stage).toBe('build');
    expect(terminal.message).toBe('build stage failed: build broke');
  });

  it('marks deployment failed with deploy-stage error log when the runner throws', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => fakeAcquirer(),
      builder: fakeBuilder(),
      runner: failingRunner(),
      routeAssigner: fakeRouteAssigner(),
      routeRegistrar: fakeRouteRegistrar(),
    });

    const after = deployments.getById(d.id)!;
    expect(after.status).toBe('failed');
    expect(after.image_tag).toBe('dep-x:1');
    const events = logs.listByDeployment(d.id);
    const terminal = events[events.length - 1]!;
    expect(terminal.stage).toBe('deploy');
    expect(terminal.message).toBe('deploy stage failed: run broke');
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
        runner: fakeRunner(),
        routeAssigner: fakeRouteAssigner(),
      }),
    ).resolves.toBeUndefined();
  });

  it('does not re-transition a deployment already claimed into building', async () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    deployments.claimById(d.id);

    await runPipeline(d.id, {
      deployments,
      logs,
      acquirer: () => fakeAcquirer(),
      builder: fakeBuilder(),
      runner: fakeRunner(),
      routeAssigner: fakeRouteAssigner(),
      routeRegistrar: fakeRouteRegistrar(),
    });

    expect(deployments.getById(d.id)!.status).toBe('running');
  });
});
