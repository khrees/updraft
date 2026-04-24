import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRailpackBuilder } from './build.js';
import type { StageLogger } from './logger.js';
import { BuildFailedError } from '../lib/errors.js';
import type { Deployment } from '@updraft/shared-types';

function fakeSpawn(stdoutLines: string[], exitCode: number, captured?: { args?: readonly string[] }) {
  return ((_cmd: string, args: readonly string[]) => {
    if (captured) captured.args = args;
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    child.stdout = Readable.from([stdoutLines.map((l) => `${l}\n`).join('')]);
    child.stderr = Readable.from(['']);
    setImmediate(() => child.emit('close', exitCode));
    return child as never;
  });
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

const deployment: Deployment = {
  id: 'abc',
  source_type: 'git',
  source_ref: 'https://example.com/r.git',
  status: 'building',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

describe('railpack builder', () => {
  it('produces a deterministic image tag and streams output', async () => {
    const captured: { args?: readonly string[] } = {};
    const builder = createRailpackBuilder({
      spawn: fakeSpawn(['Detected Node.js', 'Building...'], 0, captured),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
    });
    const logger = loggerStub();
    const result = await builder.build({ deployment, workspacePath: '/tmp/ws', logger });
    const expectedTag = `dep-abc:${Math.floor(new Date('2026-04-24T00:00:00.000Z').getTime() / 1000)}`;
    expect(result.image_tag).toBe(expectedTag);
    expect(captured.args).toEqual(['build', '/tmp/ws', '--name', expectedTag]);
    expect(logger.lines).toContain('Detected Node.js');
    expect(logger.lines).toContain('Building...');
  });

  it('throws BuildFailedError on non-zero exit', async () => {
    const builder = createRailpackBuilder({
      spawn: fakeSpawn(['boom'], 1),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
    });
    await expect(
      builder.build({ deployment, workspacePath: '/tmp/ws', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(BuildFailedError);
  });
});
