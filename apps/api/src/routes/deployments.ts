import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type Database from 'better-sqlite3';
import { createDeploymentRepository, createLogRepository, DeploymentNotFoundError } from '../db/repository.js';
import { createDeploymentSchema } from '../schemas.js';
import { handleError, BadRequestError } from '../lib/errors.js';
import { subscribe } from '../sse/broker.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const UPLOAD_DIR = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'data', 'uploads');

export function createDeploymentsRouter(db: Database.Database) {
  const router = new Hono();
  const deployments = createDeploymentRepository(db);
  const logs = createLogRepository(db);

  // POST /deployments — create and enqueue
  router.post('/', async (c) => {
    try {
      const contentType = c.req.header('content-type') ?? '';
      const id = randomUUID();
      let sourceType: 'git' | 'upload';
      let sourceRef: string;

      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.formData();
        const archive = form.get('archive');
        if (!archive || !(archive instanceof File)) {
          return c.json({ success: false, message: 'multipart body must include an "archive" file field' }, 400);
        }
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const filename = `${id}-${archive.name}`;
        const dest = path.join(UPLOAD_DIR, filename);
        fs.writeFileSync(dest, Buffer.from(await archive.arrayBuffer()));
        sourceType = 'upload';
        sourceRef = filename;
      } else {
        const body = await c.req.json().catch(() => { throw new BadRequestError('Request body must be valid JSON'); });
        const parsed = createDeploymentSchema.parse(body);
        sourceType = parsed.gitUrl ? 'git' : 'upload';
        sourceRef = (parsed.gitUrl ?? parsed.archiveRef)!;
      }

      const deployment = deployments.create({ sourceType, sourceRef });
      return c.json({ success: true, message: 'Deployment created', data: deployment }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /deployments — list newest-first
  router.get('/', (c) => {
    try {
      const list = deployments.list();
      return c.json({ success: true, message: 'OK', data: list });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /deployments/:id — single deployment
  router.get('/:id', (c) => {
    try {
      const deployment = deployments.getById(c.req.param('id'));
      if (!deployment) throw new DeploymentNotFoundError(c.req.param('id'));
      return c.json({ success: true, message: 'OK', data: deployment });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /deployments/:id/logs/stream — SSE stream
  router.get('/:id/logs/stream', async (c) => {
    const deploymentId = c.req.param('id');

    const deployment = deployments.getById(deploymentId);
    if (!deployment) {
      return c.json({ success: false, message: `Deployment not found: ${deploymentId}` }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay historical logs first
      const history = logs.listByDeployment(deploymentId);
      for (const event of history) {
        await stream.writeSSE({ event: 'log', data: JSON.stringify(event) });
      }

      // If terminal, send done and close
      if (deployment.status === 'running' || deployment.status === 'failed') {
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: deployment.status }) });
        return;
      }

      // Subscribe to live events
      await new Promise<void>((resolve) => {
        const unsubscribe = subscribe(deploymentId, async (msg) => {
          if (msg.type === 'log') {
            await stream.writeSSE({ event: 'log', data: JSON.stringify(msg.data) });
          } else if (msg.type === 'status') {
            await stream.writeSSE({ event: 'status', data: JSON.stringify(msg.data) });
            if (msg.data.status === 'running' || msg.data.status === 'failed') {
              await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: msg.data.status }) });
              unsubscribe();
              resolve();
            }
          }
        });

        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  });

  return router;
}
