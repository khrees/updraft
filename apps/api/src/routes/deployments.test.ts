import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createBuildRepository, createDeploymentRepository, createLogRepository } from '../db/repository.js';
import { createDeploymentsRouter } from './deployments.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function jsonRequest(path: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('deployments router', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('rejects malformed JSON body with 400', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; message: string };
    expect(json.success).toBe(false);
  });

  it('rejects body missing git_url with 400', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid git_url with 400', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request(jsonRequest('/', { git_url: 'not a url' }));
    expect(res.status).toBe(400);
  });

  it('rejects JSON upload references and requires multipart uploads', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request(jsonRequest('/', { archive_ref: 'artifact.tar.gz' }));
    expect(res.status).toBe(400);
  });

  it('creates a deployment from a git url', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request(jsonRequest('/', { git_url: 'https://example.com/r.git' }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; status: string; source_type: string } };
    expect(json.data.status).toBe('pending');
    expect(json.data.source_type).toBe('git');
    expect(json.data.id).toBeTruthy();
  });

  it('lists created deployments newest-first', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    await router.request(jsonRequest('/', { git_url: 'https://example.com/a.git' }));
    db.prepare(`UPDATE deployments SET created_at = ?, updated_at = ?`).run(
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    await router.request(jsonRequest('/', { git_url: 'https://example.com/b.git' }));
    const res = await router.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ source_ref: string }> };
    expect(json.data).toHaveLength(2);
    expect(json.data[0]!.source_ref).toBe('https://example.com/b.git');
  });

  it('returns 404 for unknown deployment id', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request('/does-not-exist', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('lists build history for a deployment source', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const buildRepo = createBuildRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    buildRepo.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'railpack',
      created_by_deployment_id: d.id,
    });

    const res = await router.request(`/${d.id}/builds`, { method: 'GET' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ image_tag: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.image_tag).toBe('dep-a:1');
  });

  it('creates a redeploy from an existing image tag', async () => {
    const queued: string[] = [];
    const router = createDeploymentsRouter(db, { enqueue: (id) => queued.push(id) });
    const deployments = createDeploymentRepository(db);
    const buildRepo = createBuildRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    buildRepo.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'railpack',
      created_by_deployment_id: d.id,
    });

    const res = await router.request(`/${d.id}/redeploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_tag: 'dep-a:1' }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; requested_image_tag?: string } };
    expect(json.data.requested_image_tag).toBe('dep-a:1');
    expect(queued).toContain(json.data.id);
  });

  it('rejects redeploy when image_tag is not in build history', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });

    const res = await router.request(`/${d.id}/redeploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_tag: 'dep-missing:1' }),
    });
    expect(res.status).toBe(400);
  });

  it('supports rollback endpoint as redeploy alias', async () => {
    const queued: string[] = [];
    const router = createDeploymentsRouter(db, { enqueue: (id) => queued.push(id) });
    const deployments = createDeploymentRepository(db);
    const buildRepo = createBuildRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    buildRepo.record({
      source_type: d.source_type,
      source_ref: d.source_ref,
      image_tag: 'dep-a:1',
      build_method: 'railpack',
      created_by_deployment_id: d.id,
    });

    const res = await router.request(`/${d.id}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_tag: 'dep-a:1' }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    expect(queued).toContain(json.data.id);
  });

  it('cancels a pending deployment', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const created = await router.request(jsonRequest('/', { git_url: 'https://example.com/r.git' }));
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await router.request(`/${data.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { status: string } };
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('cancelled');
  });

  it('returns 409 when cancelling an already-terminal deployment', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const created = await router.request(jsonRequest('/', { git_url: 'https://example.com/r.git' }));
    const { data } = (await created.json()) as { data: { id: string } };
    await router.request(`/${data.id}/cancel`, { method: 'POST' });
    const res = await router.request(`/${data.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('returns 404 when cancelling an unknown deployment', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const res = await router.request('/does-not-exist/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('replays full log history with SSE ids and terminates on terminal status', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'a' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'b' });
    logs.append({ deployment_id: d.id, stage: 'deploy', message: 'c' });
    deployments.updateStatus(d.id, 'building');
    deployments.updateStatus(d.id, 'failed');

    const res = await router.request(`/${d.id}/logs/stream`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('id: 1');
    expect(body).toContain('id: 2');
    expect(body).toContain('id: 3');
    expect(body).toContain('event: done');
    const logCount = (body.match(/event: log/g) ?? []).length;
    expect(logCount).toBe(3);
  });

  it('resumes from Last-Event-ID and only replays logs past the cursor', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'a' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'b' });
    logs.append({ deployment_id: d.id, stage: 'deploy', message: 'c' });
    deployments.updateStatus(d.id, 'building');
    deployments.updateStatus(d.id, 'failed');

    const res = await router.request(`/${d.id}/logs/stream`, {
      method: 'GET',
      headers: { 'last-event-id': '2' },
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain('"message":"a"');
    expect(body).not.toContain('"message":"b"');
    expect(body).toContain('"message":"c"');
    expect(body).toContain('id: 3');
    const logCount = (body.match(/event: log/g) ?? []).length;
    expect(logCount).toBe(1);
  });

  it('accepts afterSequence query param as a fallback for resume', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'a' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'b' });
    deployments.updateStatus(d.id, 'building');
    deployments.updateStatus(d.id, 'failed');

    const res = await router.request(`/${d.id}/logs/stream?afterSequence=1`, { method: 'GET' });
    const body = await res.text();
    expect(body).not.toContain('"message":"a"');
    expect(body).toContain('"message":"b"');
  });

  it('emits done when a deployment becomes terminal during stream setup', async () => {
    const router = createDeploymentsRouter(db, { enqueue: () => {} });
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ source_type: 'git', source_ref: 'https://example.com/r.git' });
    logs.append({ deployment_id: d.id, stage: 'build', message: 'a' });
    deployments.updateStatus(d.id, 'building');
    deployments.updateStatus(d.id, 'failed');

    const res = await router.request(`/${d.id}/logs/stream`, { method: 'GET' });
    const body = await res.text();
    expect(body).toContain('event: done');
    expect(body).toContain('"status":"failed"');
  });
});
