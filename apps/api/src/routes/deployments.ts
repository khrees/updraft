import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type Database from 'better-sqlite3';
import { createDeploymentRepository, createLogRepository, DeploymentNotFoundError } from '../db/repository.js';
import { createDeploymentSchema } from '../schemas.js';
import { handleError, BadRequestError, ConflictError } from '../lib/errors.js';
import { subscribe } from '../sse/broker.js';
import { getPipelineQueue } from '../pipeline/index.js';
import { isTerminalDeploymentStatus } from '@updraft/shared-types';
import { customAlphabet } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 21);

const UPLOAD_DIR = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'data', 'uploads');

export interface DeploymentsRouterOptions {
  enqueue?: (deploymentId: string) => void;
}

export function createDeploymentsRouter(db: Database.Database, options: DeploymentsRouterOptions = {}) {
  const router = new Hono();
  const deployments = createDeploymentRepository(db);
  const logs = createLogRepository(db);
  const enqueue = options.enqueue ?? ((id: string) => getPipelineQueue(db).enqueue(id));

  // POST /deployments — create and enqueue
  router.post('/', async (c) => {
    try {
      const contentType = c.req.header('content-type') ?? '';
      const id = nanoid();
      let source_type: 'git' | 'upload';
      let source_ref: string;

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
        source_type = 'upload';
        source_ref = filename;
      } else {
        const body = await c.req.json().catch(() => { throw new BadRequestError('Request body must be valid JSON'); });
        const parsed = createDeploymentSchema.parse(body);
        source_type = parsed.git_url ? 'git' : 'upload';
        source_ref = (parsed.git_url ?? parsed.archive_ref)!;
      }

      const deployment = deployments.create({ source_type, source_ref });
      enqueue(deployment.id);
      return c.json({ success: true, message: `Deployment ${deployment.id} created and queued`, data: deployment }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /deployments — list newest-first
  router.get('/', (c) => {
    try {
      const list = deployments.list();
      return c.json({ success: true, message: `${list.length} deployment(s) found`, data: list });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /deployments/:id — single deployment
  router.get('/:id', (c) => {
    try {
      const deployment = deployments.getById(c.req.param('id'));
      if (!deployment) throw new DeploymentNotFoundError(c.req.param('id'));
      return c.json({ success: true, message: `Deployment ${deployment.id} retrieved`, data: deployment });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /deployments/:id/cancel — cancel a non-terminal deployment
  router.post('/:id/cancel', async (c) => {
    try {
      const deployment = deployments.getById(c.req.param('id'));
      if (!deployment) throw new DeploymentNotFoundError(c.req.param('id'));
      if (isTerminalDeploymentStatus(deployment.status)) {
        throw new ConflictError(`Deployment is already in a terminal state: ${deployment.status}`);
      }
      const updated = deployments.updateStatus(deployment.id, 'cancelled');
      return c.json({ success: true, message: `Deployment ${updated.id} cancelled`, data: updated });
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

      if (isTerminalDeploymentStatus(deployment.status)) {
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
            if (isTerminalDeploymentStatus(msg.data.status)) {
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
