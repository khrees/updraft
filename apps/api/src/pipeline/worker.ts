import path from 'node:path';
import type { DeploymentSourceType, LogStage } from '@updraft/shared-types';
import type { BuildCacheRepository, BuildRepository, DeploymentRepository, LogRepository } from '../db/repository.js';
import { createStageLogger, type StageLogger } from './logger.js';
import { selectAcquirer, type SourceAcquirer } from './sources.js';
import { prepareWorkspace } from './prepare.js';
import { createRailpackBuilder, type Builder } from './build.js';
import { createDockerRunner, type Runner } from './runner.js';
import { createPathRouteAssigner, type RouteAssigner } from './routing.js';
import { createCaddyRouteRegistrar, type RouteRegistrar } from './caddy.js';
import { publish } from '../sse/broker.js';

export interface PipelineDeps {
  deployments: DeploymentRepository;
  logs: LogRepository;
  builds: BuildRepository;
  buildCache?: BuildCacheRepository;
  publish?: typeof publish;
  acquirer?: (sourceType: DeploymentSourceType) => SourceAcquirer;
  builder?: Builder;
  runner?: Runner;
  routeAssigner?: RouteAssigner;
  routeRegistrar?: RouteRegistrar;
  workspaceRoot?: string;
}

class StageError extends Error {
  constructor(public readonly stage: LogStage, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StageError';
  }
}

async function runStage<T>(stage: LogStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError(stage, message, err);
  }
}

export async function runPipeline(deploymentId: string, deps: PipelineDeps): Promise<void> {
  const { deployments, logs, builds, buildCache } = deps;
  const broadcast = deps.publish ?? publish;
  const workspaceRoot = deps.workspaceRoot ?? process.env['WORKSPACE_ROOT'] ?? path.join(process.cwd(), 'data', 'workspaces');
  const acquirerFor = deps.acquirer ?? ((t) => selectAcquirer(t));
  const builder = deps.builder ?? createRailpackBuilder({ cacheRepo: buildCache });
  const runner = deps.runner ?? createDockerRunner();
  const routeAssigner = deps.routeAssigner ?? createPathRouteAssigner();
  const routeRegistrar = deps.routeRegistrar ?? createCaddyRouteRegistrar();

  const loggerFor = (stage: LogStage): StageLogger =>
    createStageLogger(deploymentId, stage, { logs, deployments, publish: broadcast });
  const sysLogger = loggerFor('system');

  try {
    const deployment = deployments.getById(deploymentId);
    if (!deployment) {
      console.error(`pipeline: deployment ${deploymentId} not found`);
      return;
    }

    // claim() writes status='building' before runPipeline is invoked, so the DB is
    // already correct. If somehow the deployment is still 'pending' (e.g. called
    // directly in tests), do the transition now. Either way, broadcast the SSE event
    // so clients see the pending→building transition.
    if (deployment.status === 'pending') {
      await sysLogger.status('building');
    } else {
      broadcast(deploymentId, { type: 'status', data: { deployment_id: deploymentId, status: 'building' } });
    }

    const workspaceDir = path.join(workspaceRoot, deploymentId);
    let image_tag = deployment.requested_image_tag;
    if (image_tag) {
      await loggerFor('build').log(`Reusing existing image tag: ${image_tag}`);
      builds.record({
        source_type: deployment.source_type,
        source_ref: deployment.source_ref,
        image_tag,
        build_method: 'reused',
        created_by_deployment_id: deploymentId,
      });
    } else {
      const { workspacePath } = await runStage('system', () =>
        acquirerFor(deployment.source_type).acquire({
          deployment,
          workspaceDir,
          logger: loggerFor('system'),
        }),
      );

      await runStage('system', () =>
        prepareWorkspace({ workspacePath, logger: loggerFor('system') }),
      );

      const built = await runStage('build', () =>
        builder.build({ deployment, workspacePath, logger: loggerFor('build') }),
      );
      image_tag = built.image_tag;
      builds.record({
        source_type: deployment.source_type,
        source_ref: deployment.source_ref,
        image_tag,
        build_method: 'railpack',
        created_by_deployment_id: deploymentId,
      });
    }
    deployments.updateFields(deploymentId, { image_tag });
    await sysLogger.log(`Build complete: ${image_tag}`);

    await sysLogger.status('deploying');
    const withImage = deployments.getById(deploymentId);
    if (!withImage) throw new Error(`Deployment ${deploymentId} disappeared mid-pipeline`);
    const { container_id, container_name, internal_port } = await runStage('deploy', () =>
      runner.run({ deployment: withImage, imageTag: image_tag, logger: loggerFor('deploy') }),
    );
    deployments.updateFields(deploymentId, {
      container_id,
      container_name,
      internal_port,
    });
    await sysLogger.log(`Container started: ${container_id}`);

    const routedDeployment = deployments.getById(deploymentId);
    if (!routedDeployment) throw new Error(`Deployment ${deploymentId} disappeared mid-pipeline`);
    const { route_path, live_url } = await runStage('system', async () =>
      routeAssigner.assign({ deployment: routedDeployment }),
    );
    deployments.updateFields(deploymentId, { route_path, live_url });
    await sysLogger.log(`Route assigned: ${live_url}`);

    await runStage('system', async () => {
      await routeRegistrar.register({
        deploymentId,
        containerName: container_name,
        internalPort: internal_port,
      });
    });
    await sysLogger.log(`Caddy route registered: /d/${deploymentId}`);

    await sysLogger.status('running');
  } catch (err) {
    const stage: LogStage = err instanceof StageError ? err.stage : 'system';
    const message = err instanceof Error ? err.message : String(err);
    try {
      await loggerFor(stage).log(`${stage} stage failed: ${message}`);
      await sysLogger.status('failed');
    } catch (innerErr) {
      console.error(`pipeline: failed to record failure for ${deploymentId}:`, innerErr);
    }
  }
}
