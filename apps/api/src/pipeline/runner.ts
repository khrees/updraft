import Dockerode from 'dockerode';
import { DeployFailedError } from '../lib/errors.js';
import type { StageLogger } from './logger.js';
import type { Deployment } from '@updraft/shared-types';

export interface RunInput {
  deployment: Deployment;
  imageTag: string;
  logger: StageLogger;
}

export interface RunResult {
  container_id: string;
  container_name: string;
  internal_port: number;
  previous_container_id?: string;
  previous_container_name?: string;
}

export interface Runner {
  run(input: RunInput): Promise<RunResult>;
}

export interface DockerRunnerDeps {
  docker?: Dockerode;
  network?: string;
  internalPort?: number;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  drainTimeoutMs?: number;
  // Injectable for tests — defaults to real fetch
  fetchFn?: (url: string) => Promise<{ status: number }>;
}

export interface DockerRunner {
  run(input: RunInput): Promise<RunResult>;
  docker: Dockerode;
}

async function ensureNetwork(docker: Dockerode, name: string): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (!networks.some((n) => n.Name === name)) {
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
  }
}

async function waitUntilContainerRunning(
  container: Dockerode.Container,
  intervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = (await container.inspect()).State;
    const status = state.Status ?? 'unknown';
    const health = (state as { Health?: { Status?: string } }).Health?.Status;

    if (status === 'exited' || status === 'dead' || health === 'unhealthy') {
      throw new DeployFailedError(
        `Container failed to start (status=${status}, health=${health ?? 'none'})`,
      );
    }

    if (status === 'running' && (!health || health === 'healthy')) return;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new DeployFailedError(`Container did not start within ${timeoutMs}ms`);
}

async function waitUntilAppResponding(
  containerName: string,
  internalPort: number,
  intervalMs: number,
  timeoutMs: number,
  fetchFn: (url: string) => Promise<{ status: number }>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const res = await fetchFn(`http://${containerName}:${internalPort}/`);
      if (res.status < 500) return;
    } catch {
      // App isn't ready yet — keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new DeployFailedError(`App did not respond within ${timeoutMs}ms`);
}

async function drainContainer(
  docker: Dockerode,
  containerName: string,
  drainTimeoutMs: number,
  logger: StageLogger,
): Promise<void> {
  try {
    const c = docker.getContainer(containerName);
    await logger.log(`[handoff] Stopping old container ${containerName} (drain timeout ${drainTimeoutMs}ms)`);
    // Docker stop sends SIGTERM then SIGKILL after t seconds
    const timeoutSec = Math.ceil(drainTimeoutMs / 1000);
    await c.stop({ t: timeoutSec });
    await c.remove();
    await logger.log(`[handoff] Old container ${containerName} removed`);
  } catch (err: unknown) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) return; // already gone
    await logger.log(`[handoff] Warning: could not stop old container ${containerName}: ${(err as Error).message}`);
  }
}

export function createDockerRunner(deps: DockerRunnerDeps = {}): DockerRunner {
  const docker = deps.docker ?? new Dockerode();
  const network = deps.network ?? process.env['DEPLOYMENT_NETWORK'] ?? 'updraft_deployments';
  const internalPort = deps.internalPort ?? Number(process.env['APP_INTERNAL_PORT'] ?? 3000);
  const healthCheckIntervalMs = deps.healthCheckIntervalMs ?? 200;
  const healthCheckTimeoutMs = deps.healthCheckTimeoutMs ?? 30000;
  const drainTimeoutMs = deps.drainTimeoutMs ?? Number(process.env['DRAIN_TIMEOUT_MS'] ?? 10000);
  const fetchFn = deps.fetchFn ?? ((url: string) => fetch(url));

  return {
    docker,
    async run({ deployment, imageTag, logger }) {
      await ensureNetwork(docker, network);

      // B-03: two-container zero-downtime handoff.
      // The stable name (dep-<id>) is what Caddy routes to.
      // We start a new container under a timestamped revision name, health-check
      // it, rename it to the stable name (which atomically replaces the slot),
      // then drain the old container.
      const stableName = `dep-${deployment.id}`;
      const revName = `${stableName}-rev-${Date.now()}`;

      // Find any currently-running container under the stable name so we can
      // drain it after the new one is healthy.
      let oldContainerId: string | undefined;
      let oldContainerName: string | undefined;
      try {
        const existing = docker.getContainer(stableName);
        const info = await existing.inspect();
        oldContainerId = info.Id;
        oldContainerName = stableName;
      } catch (err: unknown) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
        // No existing container — first deploy
      }

      let newInfo: Dockerode.ContainerInspectInfo;
      let newContainer: Dockerode.Container | undefined;
      try {
        await logger.log(`[handoff] Starting new container ${revName} from ${imageTag} on network ${network}`);

        newContainer = await docker.createContainer({
          name: revName,
          Image: imageTag,
          Env: [`PORT=${internalPort}`],
          Labels: {
            'updraft.deployment': deployment.id,
            'updraft.port': String(internalPort),
          },
          HostConfig: {
            NetworkMode: network,
            RestartPolicy: { Name: 'always' },
          } as any,
        });

        await newContainer.start();
        newInfo = await newContainer.inspect();

        await logger.log(`[handoff] New container ${revName} started (${newInfo.Id.slice(0, 12)}), waiting for container to be running`);

        // Wait for container to be in "running" state before attempting rename
        await waitUntilContainerRunning(newContainer, healthCheckIntervalMs, healthCheckTimeoutMs);

        await logger.log(`[handoff] New container healthy — renaming ${revName} → ${stableName}`);

        // Remove the old stable-named container before rename so Docker doesn't error
        if (oldContainerName) {
          try {
            const old = docker.getContainer(oldContainerName);
            await old.rename({ name: `${stableName}-draining-${Date.now()}` });
            await logger.log(`[handoff] Old container renamed away from stable slot`);
          } catch (err: unknown) {
            if ((err as { statusCode?: number }).statusCode !== 404) throw err;
          }
        }

        // Rename new container to stable name so Caddy keeps routing to the same hostname
        await newContainer.rename({ name: stableName });
        await logger.log(`[handoff] Route slot ${stableName} now points to new container ${newInfo.Id.slice(0, 12)}`);

        // Wait for the app to actually respond via HTTP (not just container running)
        await logger.log(`[handoff] Waiting for app to respond on http://${stableName}:${internalPort}/`);
        await waitUntilAppResponding(stableName, internalPort, healthCheckIntervalMs, healthCheckTimeoutMs, fetchFn);
        await logger.log(`[handoff] App is responding — deployment is live`);
      } catch (err) {
        // Rollback: remove the new container if we crashed between creation and successful rename.
        if (newContainer) {
          try {
            await newContainer.kill();
            await newContainer.remove();
          } catch (rollbackErr) {
            await logger.log(`[handoff] Rollback failed to remove new container: ${(rollbackErr as Error).message}`);
          }
        }
        throw err;
      }

      // Drain old container synchronously before declaring the pipeline complete.
      if (oldContainerId && oldContainerName) {
        const drainName = `${stableName}-draining-${oldContainerId.slice(0, 8)}`;
        await drainContainer(docker, drainName, drainTimeoutMs, logger);
      }

      const result: RunResult = {
        container_id: newInfo.Id,
        container_name: stableName,
        internal_port: internalPort,
      };
      if (oldContainerId) result.previous_container_id = oldContainerId;
      if (oldContainerName) result.previous_container_name = oldContainerName;

      await logger.log(`Container ${stableName} is running`);
      return result;
    },
  };
}
