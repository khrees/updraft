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
    const router = createDeploymentsRouter(db);
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; message: string };
    expect(json.success).toBe(false);
  });

  it('rejects body missing both gitUrl and archiveRef with 400', async () => {
    const router = createDeploymentsRouter(db);
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid gitUrl with 400', async () => {
    const router = createDeploymentsRouter(db);
    const res = await router.request(jsonRequest('/', { gitUrl: 'not a url' }));
    expect(res.status).toBe(400);
  });

  it('creates a deployment from a git url', async () => {
    const router = createDeploymentsRouter(db);
    const res = await router.request(jsonRequest('/', { gitUrl: 'https://example.com/r.git' }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; status: string; sourceType: string } };
    expect(json.data.status).toBe('pending');
    expect(json.data.sourceType).toBe('git');
    expect(json.data.id).toBeTruthy();
  });

  it('lists created deployments newest-first', async () => {
    const router = createDeploymentsRouter(db);
    await router.request(jsonRequest('/', { gitUrl: 'https://example.com/a.git' }));
    await router.request(jsonRequest('/', { gitUrl: 'https://example.com/b.git' }));
    const res = await router.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ sourceRef: string }> };
    expect(json.data).toHaveLength(2);
    expect(json.data[0]!.sourceRef).toBe('https://example.com/b.git');
  });

  it('returns 404 for unknown deployment id', async () => {
    const router = createDeploymentsRouter(db);
    const res = await router.request('/does-not-exist', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
