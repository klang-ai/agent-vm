import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { SSH_KEY, vmPaths, type VmConfig } from './state.js';
import { run, runInherit, UserError, type RunResult } from './util.js';

const AGENTD_GUEST_PORT = 7777;
const CDP_GUEST_PORT = 9222;

function sshOptions(vm: VmConfig): string[] {
  const p = vmPaths(vm.name);
  return [
    '-i',
    SSH_KEY,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    `ControlPath=${p.sshControl}`,
  ];
}

const target = (vm: VmConfig) => `${vm.user}@127.0.0.1`;

const powershell = (script: string) =>
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`;

// Windows PowerShell started with -EncodedCommand writes its error stream as CLIXML
// ("#< CLIXML <Objs>...") whenever stderr is not a console. Turn it back into text.
export function decodeClixml(stderr: string): string {
  return stderr.replace(/#< CLIXML\r?\n(<Objs[\s\S]*?<\/Objs>)/g, (_, xml: string) =>
    [...xml.matchAll(/<S S="(?:Error|Warning|warning|Verbose|Debug|Information)">([\s\S]*?)<\/S>/g)]
      .map((m) => m[1] ?? '')
      .join('')
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\r\n/g, '\n'),
  );
}

// Guest commands are PowerShell, sent base64-encoded as UTF-16LE so no quoting survives
// three shells (local, sshd, cmd) by accident.
// It ends in a newline so PowerShell errors quote the user's line, not the prelude.
// The PATH refresh matters: sshd hands every session the environment it started with, so
// without it a tool installed a minute ago (node, ffmpeg, your app) is "not recognized".
export function encodePowerShell(script: string): string {
  const prelude =
    "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;" +
    "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')\n";
  // Like a shell: a failing last command makes the exit code, its own code if it was a program.
  const epilogue = '\nif (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }';
  return Buffer.from(prelude + script + epilogue, 'utf16le').toString('base64');
}

// One long-lived master connection makes every later command ~20 ms instead of a full
// handshake, and carries the port forwards to the guest-only services.
export async function ensureMaster(vm: VmConfig) {
  const opts = sshOptions(vm);
  const check = await run('ssh', [...opts, '-p', String(vm.ports.ssh), '-O', 'check', target(vm)], {
    check: false,
  });
  if (check.code === 0) return;
  const result = await run(
    'ssh',
    [
      ...opts,
      '-p',
      String(vm.ports.ssh),
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${vm.ports.agentd}:127.0.0.1:${AGENTD_GUEST_PORT}`,
      '-L',
      `127.0.0.1:${vm.ports.cdp}:127.0.0.1:${CDP_GUEST_PORT}`,
      '-fN',
      target(vm),
    ],
    { check: false },
  );
  if (result.code !== 0) {
    throw new UserError(`Cannot reach ${vm.name} over SSH: ${result.stderr.trim() || 'connection failed'}`);
  }
}

export async function closeMaster(vm: VmConfig) {
  await run('ssh', [...sshOptions(vm), '-p', String(vm.ports.ssh), '-O', 'exit', target(vm)], {
    check: false,
  });
}

export async function sshReachable(vm: VmConfig): Promise<boolean> {
  try {
    await ensureMaster(vm);
    return true;
  } catch {
    return false;
  }
}

export async function sshExec(
  vm: VmConfig,
  script: string,
  { input }: { input?: string } = {},
): Promise<RunResult> {
  await ensureMaster(vm);
  const result = await run(
    'ssh',
    [...sshOptions(vm), '-p', String(vm.ports.ssh), target(vm), powershell(script)],
    {
      check: false,
      input,
    },
  );
  return { ...result, stderr: decodeClixml(result.stderr) };
}

// Streams stdout as it comes (for long installs); stderr is decoded and printed at the end.
export async function sshExecInherit(vm: VmConfig, script: string): Promise<number> {
  await ensureMaster(vm);
  const child = spawn(
    'ssh',
    [...sshOptions(vm), '-p', String(vm.ports.ssh), target(vm), powershell(script)],
    {
      stdio: ['ignore', 'inherit', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number>((resolve) =>
    child.on('close', (c) => {
      resolve(c ?? 1);
    }),
  );
  process.stderr.write(decodeClixml(stderr));
  return code;
}

export async function sshShell(vm: VmConfig): Promise<number> {
  await ensureMaster(vm);
  return runInherit('ssh', [
    ...sshOptions(vm),
    '-p',
    String(vm.ports.ssh),
    '-t',
    target(vm),
    'powershell -NoLogo',
  ]);
}

// scp paths on Windows accept forward slashes; a drive letter needs a leading slash.
const remotePath = (path: string) => '/' + path.replace(/\\/g, '/').replace(/^\/+/, '');

export async function push(vm: VmConfig, local: string, remote: string) {
  await ensureMaster(vm);
  await run('scp', [
    ...sshOptions(vm),
    '-P',
    String(vm.ports.ssh),
    '-r',
    local,
    `${target(vm)}:${remotePath(remote)}`,
  ]);
}

export async function pull(vm: VmConfig, remote: string, local: string) {
  await ensureMaster(vm);
  await run('scp', [
    ...sshOptions(vm),
    '-P',
    String(vm.ports.ssh),
    '-r',
    `${target(vm)}:${remotePath(remote)}`,
    local,
  ]);
}

export interface DesktopResult extends RunResult {
  pid?: number;
  timedOut?: boolean;
}

function agentdToken(vm: VmConfig): string {
  const { agentdToken: path } = vmPaths(vm.name);
  if (!existsSync(path)) throw new UserError(`${vm.name} has no agentd token; was it bootstrapped?`);
  return readFileSync(path, 'utf8').trim();
}

function agentdRequest<T>(vm: VmConfig, method: string, path: string, body?: unknown, timeoutMs = 130_000) {
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: vm.ports.agentd,
        method,
        path,
        headers: { 'x-agent-vm-token': agentdToken(vm), 'content-type': 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`agentd ${res.statusCode}: ${data}`));
            return;
          }
          resolve(JSON.parse(data) as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('agentd request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function desktopHealth(vm: VmConfig) {
  await ensureMaster(vm);
  return agentdRequest<{ ok: boolean; user: string }>(vm, 'GET', '/health', undefined, 5000);
}

// Runs PowerShell inside the signed-in user's desktop session (via agentd), where windows are
// visible and UI Automation works.
export async function desktopExec(
  vm: VmConfig,
  script: string,
  opts: { timeoutMs?: number; detach?: boolean; env?: Record<string, string> } = {},
): Promise<DesktopResult> {
  await ensureMaster(vm);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return agentdRequest<DesktopResult>(
    vm,
    'POST',
    '/exec',
    { script, ...opts, timeoutMs },
    timeoutMs + 10_000,
  );
}
