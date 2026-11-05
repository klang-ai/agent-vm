import { spawn, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { input?: string | Buffer; check?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new UserError(`'${cmd}' is not installed`) : e);
    });
    child.on('close', (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      };
      if (opts.check !== false && result.code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`));
      } else resolve(result);
    });
    child.stdin.end(opts.input);
  });
}

export function runInherit(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

export function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(dir, cmd);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  { timeoutMs = 60_000, intervalMs = 1000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new UserError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${detail}`);
}

export function freePort(preferred: number, taken = new Set<number>()): Promise<number> {
  const tryPort = (port: number): Promise<number> =>
    new Promise((resolve) => {
      if (taken.has(port)) {
        resolve(tryPort(port + 1));
        return;
      }
      const server = createServer();
      server.once('error', () => {
        resolve(tryPort(port + 1));
      });
      server.listen(port, '127.0.0.1', () =>
        server.close(() => {
          resolve(port);
        }),
      );
    });
  return tryPort(preferred);
}

export function log(message: string) {
  process.stderr.write(`${message}\n`);
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
