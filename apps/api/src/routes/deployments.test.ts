import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
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

  it('rejects body missing both git_url and archive_ref with 400', async () => {
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
});
