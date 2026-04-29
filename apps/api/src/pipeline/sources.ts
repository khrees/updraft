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

function isValidGitUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const validProtocols = ['https:', 'http:', 'git+ssh:', 'ssh:'];
    if (!validProtocols.includes(parsed.protocol)) {
      return false;
    }
    if (parsed.host === 'localhost' || parsed.host === '127.0.0.1') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createGitAcquirer(deps: GitAcquirerDeps = {}): SourceAcquirer {
  return {
    async acquire({ deployment, workspaceDir, logger }) {
      if (!isValidGitUrl(deployment.source_ref)) {
        throw new SourceAcquisitionError(`Invalid git URL: ${deployment.source_ref}`);
      }
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
      await logger.log(`Cloning ${deployment.source_ref}`);
      const result = await runStreaming(
        'git',
        ['clone', '--depth', '1', '--', deployment.source_ref, workspaceDir],
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
  const uploadDir = deps.uploadDir ?? process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'data', 'uploads');
  return {
    async acquire({ deployment, workspaceDir, logger }) {
      // Validate source_ref doesn't escape uploadDir.
      const archivePath = path.resolve(uploadDir, deployment.source_ref);
      if (!archivePath.startsWith(path.resolve(uploadDir) + path.sep)) {
        throw new SourceAcquisitionError(`Invalid archive path: ${deployment.source_ref}`);
      }
      if (!fs.existsSync(archivePath)) {
        throw new SourceAcquisitionError(`Upload archive not found at ${archivePath}`);
      }
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      await logger.log(`Extracting ${deployment.source_ref}`);
      const result = await runStreaming(
        'tar',
        [
          '-xf', archivePath,
          '-C', workspaceDir,
          '--no-absolute-filenames',  // rewrite absolute paths to relative
          '--no-overwrite-dir',       // prevent replacing directories with symlinks
        ],
        async (line) => {
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
      );
      if (result.exitCode !== 0) {
        // Clean up the archive even on failure to avoid disk accumulation.
        try { fs.unlinkSync(archivePath); } catch { /* best-effort */ }
        throw new SourceAcquisitionError(`tar extract exited with code ${result.exitCode}`);
      }
      fs.unlinkSync(archivePath);
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
