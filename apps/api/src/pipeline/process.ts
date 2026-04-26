import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export type LineSource = 'stdout' | 'stderr';
export type OnLine = (line: string, source: LineSource) => void | Promise<void>;

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

export interface SpawnResult {
  exitCode: number;
}

export async function runStreaming(
  cmd: string,
  args: readonly string[],
  onLine: OnLine,
  opts: SpawnOptions = {},
  timeoutMs?: number,
): Promise<SpawnResult> {
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as NonNullable<SpawnOptions['spawn']>);
  console.log(`[spawn] ${cmd} ${args.join(' ')}`, opts.cwd ? `cwd=${opts.cwd}` : '');
  const child = spawnFn(cmd, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });

  const pending: Promise<void>[] = [];
  const enqueueLine = (line: string, source: LineSource) => {
    const result = onLine(line, source);
    if (result && typeof (result as Promise<void>).then === 'function') {
      pending.push(result as Promise<void>);
    }
  };

  const stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  stdoutReader.on('line', (line) => enqueueLine(line, 'stdout'));
  stderrReader.on('line', (line) => enqueueLine(line, 'stderr'));

  return new Promise<SpawnResult>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
        reject(new Error(`Build timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.once('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.once('close', (code) => {
      if (timeout) clearTimeout(timeout);
      stdoutReader.close();
      stderrReader.close();
      Promise.allSettled(pending).then(() => resolve({ exitCode: code ?? 0 }));
    });
  });
}
