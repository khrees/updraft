import type { Deployment } from '@updraft/shared-types';
import { runStreaming, type SpawnOptions } from './process.js';
import { BuildFailedError } from '../lib/errors.js';
import type { StageLogger } from './logger.js';

export interface BuildInput {
  deployment: Deployment;
  workspacePath: string;
  logger: StageLogger;
}

export interface BuildResult {
  image_tag: string;
}

export interface Builder {
  build(input: BuildInput): Promise<BuildResult>;
}

export interface RailpackBuilderDeps {
  spawn?: SpawnOptions['spawn'];
  now?: () => Date;
  command?: string;
  timeoutMs?: number;
}

export function createRailpackBuilder(deps: RailpackBuilderDeps = {}): Builder {
  const command = deps.command ?? 'railpack';
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 300000;
  return {
    async build({ deployment, workspacePath, logger }) {
      const image_tag = `dep-${deployment.id}:${Math.floor(now().getTime() / 1000)}`;
      await logger.log(`Building image ${image_tag} from ${workspacePath}`);
      const result = await runStreaming(
        command,
        ['build', workspacePath, '--name', image_tag],
        async (line) => {
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
        timeoutMs,
      );
      if (result.exitCode !== 0) {
        throw new BuildFailedError(`railpack build exited with code ${result.exitCode}`);
      }
      return { image_tag };
    },
  };
}
