import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitAcquirer,
  createUploadAcquirer,
  selectAcquirer,
} from './sources.js';
import type { StageLogger } from './logger.js';
import { SourceAcquisitionError } from '../lib/errors.js';
import type { Deployment } from '@updraft/shared-types';

function fakeSpawn(stdoutLines: string[], exitCode: number) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    child.stdout = Readable.from([stdoutLines.map((l) => `${l}\n`).join('')]);
    child.stderr = Readable.from(['']);
    setImmediate(() => child.emit('close', exitCode));
    return child as never;
  };
}

function loggerStub(): StageLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async log(msg) {
      lines.push(msg);
    },
    async status() {},
  };
}

const baseDeployment: Deployment = {
  id: 'd1',
  source_type: 'git',
  source_ref: 'https://example.com/repo.git',
  status: 'pending',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

describe('git acquirer', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-src-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('streams clone output and returns the workspace path', async () => {
    const logger = loggerStub();
    const acquirer = createGitAcquirer({ spawn: fakeSpawn(['Cloning into x...', 'done'], 0) });
    const result = await acquirer.acquire({
      deployment: baseDeployment,
      workspaceDir: path.join(tmp, 'd1'),
      logger,
    });
    expect(result.workspacePath).toBe(path.join(tmp, 'd1'));
    expect(logger.lines).toContain('Cloning https://example.com/repo.git');
    expect(logger.lines).toContain('Cloning into x...');
  });

  it('throws SourceAcquisitionError on non-zero exit', async () => {
    const acquirer = createGitAcquirer({ spawn: fakeSpawn(['fatal: nope'], 128) });
    await expect(
      acquirer.acquire({
        deployment: baseDeployment,
        workspaceDir: path.join(tmp, 'd1'),
        logger: loggerStub(),
      }),
    ).rejects.toBeInstanceOf(SourceAcquisitionError);
  });
});

describe('upload acquirer', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-up-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('throws when archive is missing', async () => {
    const acquirer = createUploadAcquirer({ uploadDir: tmp });
    await expect(
      acquirer.acquire({
        deployment: { ...baseDeployment, source_type: 'upload', source_ref: 'missing.tar' },
        workspaceDir: path.join(tmp, 'ws'),
        logger: loggerStub(),
      }),
    ).rejects.toBeInstanceOf(SourceAcquisitionError);
  });

  it('extracts an existing archive via tar', async () => {
    const archive = path.join(tmp, 'src.tar');
    fs.writeFileSync(archive, 'fake archive bytes');
    const logger = loggerStub();
    const acquirer = createUploadAcquirer({
      uploadDir: tmp,
      spawn: fakeSpawn(['x file1', 'x file2'], 0),
    });
    const workspaceDir = path.join(tmp, 'ws');
    const result = await acquirer.acquire({
      deployment: { ...baseDeployment, source_type: 'upload', source_ref: 'src.tar' },
      workspaceDir,
      logger,
    });
    expect(result.workspacePath).toBe(workspaceDir);
    expect(fs.existsSync(workspaceDir)).toBe(true);
    expect(logger.lines).toContain('Extracting src.tar');
  });
});

describe('selectAcquirer', () => {
  it('routes by source type', () => {
    const git = createGitAcquirer();
    const upload = createUploadAcquirer();
    expect(selectAcquirer('git', { git, upload })).toBe(git);
    expect(selectAcquirer('upload', { git, upload })).toBe(upload);
  });
});
