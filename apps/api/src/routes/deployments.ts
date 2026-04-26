import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type Database from 'better-sqlite3';
import { createBuildRepository, createDeploymentRepository, createLogRepository, DeploymentNotFoundError } from '../db/repository.js';
import { createDeploymentSchema, redeployDeploymentSchema } from '../schemas.js';
import { handleError, BadRequestError, ConflictError } from '../lib/errors.js';
import { subscribe } from '../sse/broker.js';
import { getPipelineQueue } from '../pipeline/index.js';
import { isTerminalDeploymentStatus, type SSEMessage } from '@updraft/shared-types';
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
  const builds = createBuildRepository(db);
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
        source_type = 'git';
        source_ref = parsed.git_url!;
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

  // GET /deployments/:id/builds — list prior image builds for the same source
  router.get('/:id/builds', (c) => {
    try {
      const deployment = deployments.getById(c.req.param('id'));
      if (!deployment) throw new DeploymentNotFoundError(c.req.param('id'));
      const history = builds.listForSource(deployment.source_type, deployment.source_ref);
      return c.json({ success: true, message: `${history.length} build(s) found`, data: history });
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

  const enqueueRedeploy = async (deploymentId: string, imageTag: string) => {
    const base = deployments.getById(deploymentId);
    if (!base) throw new DeploymentNotFoundError(deploymentId);
    if (!builds.hasForSourceImage(base.source_type, base.source_ref, imageTag)) {
      throw new BadRequestError(`image_tag not found for this deployment source: ${imageTag}`);
    }
    const created = deployments.create({
      source_type: base.source_type,
      source_ref: base.source_ref,
      requested_image_tag: imageTag,
    });
    logs.append({
      deployment_id: created.id,
      stage: 'system',
      message: `Redeploy requested from existing image ${imageTag}`,
    });
    enqueue(created.id);
    return created;
  };

  // POST /deployments/:id/redeploy — create a deployment from an existing image tag
  router.post('/:id/redeploy', async (c) => {
    try {
      const body = await c.req.json().catch(() => { throw new BadRequestError('Request body must be valid JSON'); });
      const parsed = redeployDeploymentSchema.parse(body);
      const created = await enqueueRedeploy(c.req.param('id'), parsed.image_tag);
      return c.json({ success: true, message: `Redeploy ${created.id} queued`, data: created }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /deployments/:id/rollback — alias of redeploy using existing image tag
  router.post('/:id/rollback', async (c) => {
    try {
      const body = await c.req.json().catch(() => { throw new BadRequestError('Request body must be valid JSON'); });
      const parsed = redeployDeploymentSchema.parse(body);
      const created = await enqueueRedeploy(c.req.param('id'), parsed.image_tag);
      return c.json({ success: true, message: `Rollback ${created.id} queued`, data: created }, 201);
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

    // Resume from Last-Event-ID (standard SSE reconnect header) or ?afterSequence= query.
    const lastEventId = c.req.header('last-event-id');
    const afterQuery = c.req.query('afterSequence');
    const parsed = Number(lastEventId ?? afterQuery ?? 0);
    const afterSequence = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    return streamSSE(c, async (stream) => {
      let lastSequence = afterSequence;
      let writes = Promise.resolve();
      let settled = false;
      let resolver: (() => void) | null = null;

      const finish = async (status: string) => {
        if (settled) return;
        settled = true;
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ status }) });
        resolver?.();
      };

      const queued: SSEMessage[] = [];
      let replaying = true;
      const unsubscribe = subscribe(deploymentId, (msg) => {
        if (replaying) {
          queued.push(msg);
          return;
        }
        writes = writes.then(async () => {
          if (msg.type === 'log') {
            if (msg.data.sequence <= lastSequence) return;
            lastSequence = msg.data.sequence;
            await stream.writeSSE({ id: String(msg.data.sequence), event: 'log', data: JSON.stringify(msg.data) });
            return;
          }
          await stream.writeSSE({ event: 'status', data: JSON.stringify(msg.data) });
          if (isTerminalDeploymentStatus(msg.data.status)) {
            await finish(msg.data.status);
          }
        });
      });

      const flushQueued = async () => {
        replaying = false;
        for (const msg of queued) {
          await writes;
          if (msg.type === 'log') {
            if (msg.data.sequence <= lastSequence) continue;
            lastSequence = msg.data.sequence;
            await stream.writeSSE({ id: String(msg.data.sequence), event: 'log', data: JSON.stringify(msg.data) });
            continue;
          }
          await stream.writeSSE({ event: 'status', data: JSON.stringify(msg.data) });
          if (isTerminalDeploymentStatus(msg.data.status)) {
            await finish(msg.data.status);
            break;
          }
        }
      };

      stream.onAbort(() => {
        unsubscribe();
        resolver?.();
      });

      try {
        const history = logs.listByDeployment(deploymentId, { afterSequence });
        for (const event of history) {
          await stream.writeSSE({ id: String(event.sequence), event: 'log', data: JSON.stringify(event) });
          lastSequence = event.sequence;
        }

        await flushQueued();
        if (settled) return;

        const current = deployments.getById(deploymentId);
        if (current && isTerminalDeploymentStatus(current.status)) {
          await finish(current.status);
          return;
        }

        await new Promise<void>((resolve) => {
          resolver = resolve;
        });
      } finally {
        unsubscribe();
      }
    });
  });

  return router;
}
