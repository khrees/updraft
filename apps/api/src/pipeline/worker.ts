import path from 'node:path';
import type { DeploymentSourceType } from '@updraft/shared-types';
import type { DeploymentRepository, LogRepository } from '../db/repository.js';
import { createStageLogger } from './logger.js';
import { selectAcquirer, type SourceAcquirer } from './sources.js';
import { createRailpackBuilder, type Builder } from './build.js';
import { publish } from '../sse/broker.js';

export interface PipelineDeps {
  deployments: DeploymentRepository;
  logs: LogRepository;
  publish?: typeof publish;
  acquirer?: (sourceType: DeploymentSourceType) => SourceAcquirer;
  builder?: Builder;
  workspaceRoot?: string;
}

export async function runPipeline(deploymentId: string, deps: PipelineDeps): Promise<void> {
  const { deployments, logs } = deps;
  const broadcast = deps.publish ?? publish;
  const workspaceRoot = deps.workspaceRoot ?? path.join(process.cwd(), 'data', 'workspaces');
  const acquirerFor = deps.acquirer ?? ((t) => selectAcquirer(t));
  const builder = deps.builder ?? createRailpackBuilder();

  const sysLogger = createStageLogger(deploymentId, 'system', { logs, deployments, publish: broadcast });

  try {
    const deployment = deployments.getById(deploymentId);
    if (!deployment) {
      console.error(`pipeline: deployment ${deploymentId} not found`);
      return;
    }

    await sysLogger.status('building');

    const acquireLogger = createStageLogger(deploymentId, 'system', { logs, deployments, publish: broadcast });
    const workspaceDir = path.join(workspaceRoot, deploymentId);
    const { workspacePath } = await acquirerFor(deployment.source_type).acquire({
      deployment,
      workspaceDir,
      logger: acquireLogger,
    });

    const buildLogger = createStageLogger(deploymentId, 'build', { logs, deployments, publish: broadcast });
    const { image_tag } = await builder.build({
      deployment,
      workspacePath,
      logger: buildLogger,
    });

    deployments.updateFields(deploymentId, { image_tag });
    await sysLogger.log(`Build complete: ${image_tag}`);
    // Stops at 'building' until C-04 (deploy) and C-05 (route) land.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await sysLogger.log(`Pipeline failed: ${message}`);
      await sysLogger.status('failed');
    } catch (innerErr) {
      console.error(`pipeline: failed to record failure for ${deploymentId}:`, innerErr);
    }
  }
}
