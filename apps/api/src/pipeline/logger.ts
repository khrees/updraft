import type { DeploymentStatus, LogStage } from '@updraft/shared-types';
import type { DeploymentRepository, LogRepository } from '../db/repository.js';
import { publish } from '../sse/broker.js';

export interface StageLogger {
  log(message: string): Promise<void>;
  status(next: DeploymentStatus): Promise<void>;
}

export interface StageLoggerDeps {
  logs: LogRepository;
  deployments: DeploymentRepository;
  publish?: typeof publish;
}

export function createStageLogger(
  deploymentId: string,
  stage: LogStage,
  deps: StageLoggerDeps,
): StageLogger {
  const broadcast = deps.publish ?? publish;
  return {
    async log(message) {
      const event = deps.logs.append({ deployment_id: deploymentId, stage, message });
      broadcast(deploymentId, { type: 'log', data: event });
    },
    async status(next) {
      const updated = deps.deployments.updateStatus(deploymentId, next);
      broadcast(deploymentId, { type: 'status', data: { deployment_id: deploymentId, status: updated.status } });
    },
  };
}
