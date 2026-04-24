import path from 'node:path';
import fs from 'node:fs';
import type { Deployment, DeploymentSourceType } from '@updraft/shared-types';
import { runStreaming, type SpawnOptions } from './process.js';
import { SourceAcquisitionError } from '../lib/errors.js';
import type { StageLogger } from './logger.js';

export interface AcquireInput {
  deployment: Deployment;
  workspaceDir: string;
  logger: StageLogger;
}

export interface AcquireResult {
  workspacePath: string;
}

export interface SourceAcquirer {
  acquire(input: AcquireInput): Promise<AcquireResult>;
}

export interface GitAcquirerDeps {
  spawn?: SpawnOptions['spawn'];
}

export function createGitAcquirer(deps: GitAcquirerDeps = {}): SourceAcquirer {
  return {
    async acquire({ deployment, workspaceDir, logger }) {
      fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
      await logger.log(`Cloning ${deployment.source_ref}`);
      const result = await runStreaming(
        'git',
        ['clone', '--depth', '1', deployment.source_ref, workspaceDir],
        async (line) => {
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
      );
      if (result.exitCode !== 0) {
        throw new SourceAcquisitionError(`git clone exited with code ${result.exitCode}`);
      }
      return { workspacePath: workspaceDir };
    },
  };
}

export interface UploadAcquirerDeps {
  uploadDir?: string;
  spawn?: SpawnOptions['spawn'];
}

export function createUploadAcquirer(deps: UploadAcquirerDeps = {}): SourceAcquirer {
  const uploadDir = deps.uploadDir ?? path.join(process.cwd(), 'data', 'uploads');
  return {
    async acquire({ deployment, workspaceDir, logger }) {
      const archivePath = path.join(uploadDir, deployment.source_ref);
      if (!fs.existsSync(archivePath)) {
        throw new SourceAcquisitionError(`Upload archive not found at ${archivePath}`);
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      await logger.log(`Extracting ${deployment.source_ref}`);
      const result = await runStreaming(
        'tar',
        ['-xf', archivePath, '-C', workspaceDir],
        async (line) => {
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
      );
      if (result.exitCode !== 0) {
        throw new SourceAcquisitionError(`tar extract exited with code ${result.exitCode}`);
      }
      return { workspacePath: workspaceDir };
    },
  };
}

export function selectAcquirer(
  sourceType: DeploymentSourceType,
  overrides?: { git?: SourceAcquirer; upload?: SourceAcquirer },
): SourceAcquirer {
  if (sourceType === 'git') return overrides?.git ?? createGitAcquirer();
  return overrides?.upload ?? createUploadAcquirer();
}
