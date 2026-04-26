import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import {
  createBuildRepository,
  createDeploymentRepository,
  createLogRepository,
  DeploymentNotFoundError,
  InvalidStatusTransitionError,
  isValidStatusTransition,
} from './repository.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('deployment repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates a deployment in pending state', () => {
    const repo = createDeploymentRepository(db);
    const created = repo.create({ source_type: 'git', source_ref: 'https://example.com/repo.git' });
    expect(created.status).toBe('pending');
    expect(created.id).toBeTruthy();
    expect(created.source_type).toBe('git');
    expect(created.source_ref).toBe('https://example.com/repo.git');
    expect(created.created_at).toBe(created.updated_at);
  });

  it('creates a deployment with requested_image_tag for redeploys', () => {
    const repo = createDeploymentRepository(db);
    const created = repo.create({
      source_type: 'git',
      source_ref: 'https://example.com/repo.git',
      requested_image_tag: 'dep-abc:123',
    });
    expect(created.requested_image_tag).toBe('dep-abc:123');
    const fetched = repo.getById(created.id);
    expect(fetched?.requested_image_tag).toBe('dep-abc:123');
  });

  it('reads a deployment by id and returns null when missing', () => {
    const repo = createDeploymentRepository(db);
    expect(repo.getById('missing')).toBeNull();
    const created = repo.create({ source_type: 'upload', source_ref: 'artifact-123' });
    const fetched = repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.source_type).toBe('upload');
  });

  it('lists deployments newest-first', () => {
    const repo = createDeploymentRepository(db);
    const a = repo.create({ source_type: 'git', source_ref: 'a' });
    db.prepare(
      `UPDATE deployments SET created_at = ?, updated_at = ? WHERE id = ?`,
    ).run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', a.id);
    const b = repo.create({ source_type: 'git', source_ref: 'b' });
    const list = repo.list();
    expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
  });

  it('updates mutable fields', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ source_type: 'git', source_ref: 'r' });
    const updated = repo.updateFields(d.id, {
      image_tag: 'dep-1:abc',
      container_id: 'c1',
      container_name: 'dep-1',
      internal_port: 3000,
      route_path: '/d/1',
      live_url: 'http://localhost/d/1',
    });
    expect(updated.image_tag).toBe('dep-1:abc');
    expect(updated.container_id).toBe('c1');
    expect(updated.container_name).toBe('dep-1');
    expect(updated.internal_port).toBe(3000);
    expect(updated.route_path).toBe('/d/1');
    expect(updated.live_url).toBe('http://localhost/d/1');
    expect(updated.updated_at).toBeTruthy();
  });

  it('advances status through the happy path', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ source_type: 'git', source_ref: 'r' });
    expect(repo.updateStatus(d.id, 'building').status).toBe('building');
    expect(repo.updateStatus(d.id, 'deploying').status).toBe('deploying');
    expect(repo.updateStatus(d.id, 'running').status).toBe('running');
  });

  it('allows any non-terminal state to transition to failed', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ source_type: 'git', source_ref: 'r' });
    expect(repo.updateStatus(d.id, 'failed').status).toBe('failed');
  });

  it('allows any non-terminal state to transition to cancelled', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ source_type: 'git', source_ref: 'r' });
    repo.updateStatus(d.id, 'building');
    expect(repo.updateStatus(d.id, 'cancelled').status).toBe('cancelled');
  });

  it('rejects invalid status transitions', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ source_type: 'git', source_ref: 'r' });
    expect(() => repo.updateStatus(d.id, 'running')).toThrow(InvalidStatusTransitionError);
    repo.updateStatus(d.id, 'building');
    repo.updateStatus(d.id, 'deploying');
    repo.updateStatus(d.id, 'running');
    expect(() => repo.updateStatus(d.id, 'failed')).toThrow(InvalidStatusTransitionError);
    expect(() => repo.updateStatus(d.id, 'cancelled')).toThrow(InvalidStatusTransitionError);
  });

  it('throws when updating a missing deployment', () => {
    const repo = createDeploymentRepository(db);
    expect(() => repo.updateStatus('nope', 'building')).toThrow(DeploymentNotFoundError);
    expect(() => repo.updateFields('nope', { image_tag: 'x' })).toThrow(DeploymentNotFoundError);
  });

  it('exposes isValidStatusTransition helper', () => {
    expect(isValidStatusTransition('pending', 'building')).toBe(true);
    expect(isValidStatusTransition('pending', 'deploying')).toBe(false);
    expect(isValidStatusTransition('running', 'failed')).toBe(false);
    expect(isValidStatusTransition('pending', 'cancelled')).toBe(true);
    expect(isValidStatusTransition('cancelled', 'failed')).toBe(false);
  });
});

describe('build repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('records and lists build history for a source', () => {
    const deployments = createDeploymentRepository(db);
    const builds = createBuildRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/repo.git' });

    const first = builds.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'railpack',
      created_by_deployment_id: d.id,
    });
    const second = builds.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:2',
      build_method: 'reused',
      created_by_deployment_id: d.id,
    });

    const history = builds.listForSource(d.source_type, d.source_ref);
    expect(history).toHaveLength(2);
    expect(history.map((b) => b.image_tag).sort()).toEqual([first.image_tag, second.image_tag].sort());
    expect(builds.hasForSourceImage(d.source_type, d.source_ref, second.image_tag)).toBe(true);
    expect(builds.hasForSourceImage(d.source_type, d.source_ref, 'missing:tag')).toBe(false);
  });

  it('deduplicates records by source and image_tag', () => {
    const deployments = createDeploymentRepository(db);
    const builds = createBuildRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/repo.git' });

    const a = builds.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'railpack',
      created_by_deployment_id: d.id,
    });
    const b = builds.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'reused',
      created_by_deployment_id: d.id,
    });

    expect(a.id).toBe(b.id);
    expect(builds.listForSource(d.source_type, d.source_ref)).toHaveLength(1);
  });
});

describe('log repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('appends logs with monotonic per-deployment sequence numbers', () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d1 = deployments.create({ source_type: 'git', source_ref: 'a' });
    const d2 = deployments.create({ source_type: 'git', source_ref: 'b' });

    const l1 = logs.append({ deployment_id: d1.id, stage: 'build', message: 'one' });
    const l2 = logs.append({ deployment_id: d1.id, stage: 'build', message: 'two' });
    const l3 = logs.append({ deployment_id: d2.id, stage: 'build', message: 'other' });
    const l4 = logs.append({ deployment_id: d1.id, stage: 'deploy', message: 'three' });

    expect(l1.sequence).toBe(1);
    expect(l2.sequence).toBe(2);
    expect(l3.sequence).toBe(1); // independent sequence per deployment
    expect(l4.sequence).toBe(3);
  });

  it('reads logs ordered by sequence and supports afterSequence cursor', () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'r' });

    logs.append({ deployment_id: d.id, stage: 'build', message: 'a' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'b' });
    logs.append({ deployment_id: d.id, stage: 'deploy', message: 'c' });

    const all = logs.listByDeployment(d.id);
    expect(all.map((e) => e.message)).toEqual(['a', 'b', 'c']);
    expect(all.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const tail = logs.listByDeployment(d.id, { afterSequence: 1 });
    expect(tail.map((e) => e.message)).toEqual(['b', 'c']);
  });

  it('enforces UNIQUE(deployment_id, sequence) at the schema level', () => {
    const deployments = createDeploymentRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'r' });
    db.prepare(
      `INSERT INTO deployment_logs (id, deployment_id, stage, message, timestamp, sequence)
       VALUES (?, ?, 'system', 'one', ?, 1)`,
    ).run('log-a', d.id, new Date().toISOString());
    expect(() =>
      db
        .prepare(
          `INSERT INTO deployment_logs (id, deployment_id, stage, message, timestamp, sequence)
           VALUES (?, ?, 'system', 'two', ?, 1)`,
        )
        .run('log-b', d.id, new Date().toISOString()),
    ).toThrow(/UNIQUE/);
  });
});
