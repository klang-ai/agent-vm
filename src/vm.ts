import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAsset, ASSETS } from './assets.js';
import { ensureSinks, removeSinks } from './audio.js';
import { closeMaster, desktopHealth, push, sshExec, sshExecInherit, sshReachable } from './guest.js';
import { pressKeys } from './input.js';
import { isRunning, ovmfVars, qemuPid, startQemu } from './qemu.js';
import { qga, withQmp } from './qmp.js';
import { ensureDirs, HOME, saveVm, SSH_KEY, vmPaths, type VmConfig, listVms, loadVm } from './state.js';
import { freePort, log, run, sleep, UserError, waitFor } from './util.js';
import { unattendXml } from './windows/unattend.js';

export const GUEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'guest', 'windows');

export interface CreateOptions {
  name: string;
  cpus: number;
  memoryGb: number;
  diskGb: number;
  resolution: string;
  iso?: string;
  productKey?: string;
  locale: string;
  timeZone: string;
  tpm: boolean;
}

const WANTED_DRIVERS = [
  'viostor',
  'vioscsi',
  'NetKVM',
  'viogpudo',
  'vioinput',
  'vioserial',
  'viorng',
  'Balloon',
];

async function driverPaths(virtioIso: string): Promise<string[]> {
  const { stdout } = await run(
    'xorriso',
    ['-indev', virtioIso, '-find', '/', '-type', 'd', '-name', 'amd64'],
    {
      check: false,
    },
  );
  const dirs = new Set(stdout.split('\n').map((l) => l.trim().replace(/^'|'$/g, '').replace(/^\//, '')));
  return WANTED_DRIVERS.flatMap((driver) => {
    const found = [`${driver}/w11/amd64`, `${driver}/w10/amd64`].find((d) => dirs.has(d));
    return found ? [found] : [];
  });
}

async function ensureSshKey() {
  if (existsSync(SSH_KEY)) return;
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent-vm', '-f', SSH_KEY]);
}

async function buildUnattendIso(vm: VmConfig, opts: CreateOptions, virtioIso: string) {
  const p = vmPaths(vm.name);
  const staging = mkdtempSync(join(tmpdir(), 'agent-vm-unattend-'));
  try {
    mkdirSync(join(staging, 'agent-vm'));
    writeFileSync(
      join(staging, 'autounattend.xml'),
      unattendXml({
        computerName: vm.name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 15),
        user: vm.user,
        password: vm.password,
        locale: opts.locale,
        timeZone: opts.timeZone,
        productKey: opts.productKey,
        driverPaths: await driverPaths(virtioIso),
      }),
    );
    copyFileSync(join(GUEST_DIR, 'firstboot.ps1'), join(staging, 'agent-vm', 'firstboot.ps1'));
    copyFileSync(await fetchAsset('openssh'), join(staging, 'agent-vm', ASSETS.openssh.file));
    copyFileSync(`${SSH_KEY}.pub`, join(staging, 'agent-vm', 'authorized_keys'));
    await run('xorriso', [
      '-as',
      'mkisofs',
      '-quiet',
      '-J',
      '-R',
      '-V',
      'AGENTVM',
      '-o',
      p.unattendIso,
      staging,
    ]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function allocatePorts(): Promise<VmConfig['ports']> {
  const taken = new Set<number>();
  for (const name of listVms()) {
    const other = loadVm(name);
    Object.values(other.ports).forEach((port) => taken.add(port));
  }
  const pick = async (preferred: number) => {
    const port = await freePort(preferred, taken);
    taken.add(port);
    return port;
  };
  return {
    ssh: await pick(22220),
    spice: await pick(5930),
    agentd: await pick(17777),
    cdp: await pick(19222),
  };
}

function parseResolution(value: string) {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value);
  if (!match) throw new UserError(`Bad resolution '${value}'`, 'Use WIDTHxHEIGHT, e.g. 1920x1080');
  return { width: Number(match[1]), height: Number(match[2]) };
}

// The Windows ISO's EFI loader waits for "press any key" before booting setup; keep pressing.
async function pressThroughBootPrompt(vm: VmConfig) {
  const { qmp } = vmPaths(vm.name);
  const until = Date.now() + 40_000;
  await withQmp(qmp, async (q) => {
    while (Date.now() < until) {
      await pressKeys(q, ['ret']).catch(() => undefined);
      await sleep(700);
    }
  });
}

export async function create(opts: CreateOptions): Promise<VmConfig> {
  ensureDirs();
  const p = vmPaths(opts.name);
  if (existsSync(p.config)) {
    throw new UserError(`VM '${opts.name}' already exists`, `Remove it with: agent-vm destroy ${opts.name}`);
  }
  for (const tool of ['qemu-system-x86_64', 'qemu-img', 'xorriso', 'ssh', 'scp', 'pactl', 'pw-play']) {
    await run('sh', ['-c', `command -v ${tool}`]).catch(() => {
      throw new UserError(
        `${tool} is not installed`,
        'Run `agent-vm doctor` for the full list of requirements',
      );
    });
  }
  if (opts.tpm) await run('sh', ['-c', 'command -v swtpm']);
  if (!existsSync('/dev/kvm')) {
    throw new UserError('/dev/kvm missing', 'Enable virtualization (VT-x/AMD-V) in firmware');
  }

  const iso = opts.iso ? resolve(opts.iso) : await fetchAsset('windows11Eval');
  if (!existsSync(iso)) throw new UserError(`ISO not found: ${iso}`);
  const virtioIso = await fetchAsset('virtioWin');
  await ensureSshKey();

  mkdirSync(p.dir, { recursive: true });
  const vm: VmConfig = {
    name: opts.name,
    os: 'windows',
    cpus: opts.cpus,
    memoryGb: opts.memoryGb,
    diskGb: opts.diskGb,
    resolution: parseResolution(opts.resolution),
    tpm: opts.tpm,
    user: 'agent',
    password: 'agent-vm',
    ports: await allocatePorts(),
    iso,
    installed: false,
  };
  saveVm(vm);
  writeFileSync(p.agentdToken, randomBytes(24).toString('hex'), { mode: 0o600 });

  await run('qemu-img', ['create', '-q', '-f', 'qcow2', p.disk, `${vm.diskGb}G`]);
  await run('qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', ovmfVars(), p.efiVars]);
  if (vm.tpm) mkdirSync(p.tpmDir, { recursive: true });
  await buildUnattendIso(vm, opts, virtioIso);

  await install(vm);
  return vm;
}

export async function install(vm: VmConfig) {
  await ensureSinks(vm.name);
  await startQemu(vm, { install: true });
  await pressThroughBootPrompt(vm);
  log('Windows is installing unattended. This takes 15-40 minutes; watch with `agent-vm view`.');
  const started = Date.now();
  await waitFor(
    'SSH after Windows setup',
    async () => {
      if (!isRunning(vm)) throw new UserError('The VM stopped during setup', `See ${vmPaths(vm.name).log}`);
      const up = await sshReachable(vm);
      if (!up) log(`  still installing (${Math.round((Date.now() - started) / 60_000)} min)`);
      return up;
    },
    { timeoutMs: 120 * 60_000, intervalMs: 60_000 },
  );
  await bootstrap(vm);
  vm.installed = true;
  saveVm(vm);
  await checkpointSave(vm, 'clean');
  log(`${vm.name} is ready. A checkpoint named 'clean' was saved.`);
}

export async function bootstrap(vm: VmConfig) {
  log('Bootstrapping guest tools');
  const p = vmPaths(vm.name);
  const payload = 'C:/agent-vm/payload';
  await sshExec(vm, `New-Item -ItemType Directory -Force '${payload}' | Out-Null`);
  const files = [
    await fetchAsset('node'),
    await fetchAsset('ffmpeg'),
    join(GUEST_DIR, 'agentd.mjs'),
    join(GUEST_DIR, 'bootstrap.ps1'),
    p.agentdToken,
  ];
  for (const file of files) await push(vm, file, `${payload}/`);
  const code = await sshExecInherit(vm, `& '${payload}/bootstrap.ps1' -User '${vm.user}'`);
  if (code !== 0) throw new UserError(`Guest bootstrap failed (exit ${code})`);
  await waitFor('agentd in the desktop session', async () => (await desktopHealth(vm)).ok, {
    timeoutMs: 120_000,
  });
}

export async function up(vm: VmConfig, { checkpoint }: { checkpoint?: string } = {}) {
  if (!vm.installed) {
    throw new UserError(`${vm.name} never finished installing`, `Re-run: agent-vm install ${vm.name}`);
  }
  await ensureSinks(vm.name);
  if (!isRunning(vm)) {
    await startQemu(vm);
    if (checkpoint) await checkpointRestore(vm, checkpoint);
  } else if (checkpoint) {
    await checkpointRestore(vm, checkpoint);
  }
  await waitForReady(vm);
}

export async function waitForReady(vm: VmConfig, timeoutMs = 180_000) {
  await waitFor('SSH', () => sshReachable(vm), { timeoutMs, intervalMs: 2000 });
  await waitFor('agentd', async () => (await desktopHealth(vm)).ok, { timeoutMs, intervalMs: 2000 });
}

export async function down(vm: VmConfig, { force = false } = {}) {
  if (!isRunning(vm)) return;
  const { qmp } = vmPaths(vm.name);
  await closeMaster(vm);
  if (!force) {
    await withQmp(qmp, (q) => q.execute('system_powerdown'));
    try {
      await waitFor('shutdown', () => !isRunning(vm), { timeoutMs: 120_000 });
      return;
    } catch {
      log('Guest did not shut down in time; stopping QEMU');
    }
  }
  await withQmp(qmp, (q) => q.execute('quit')).catch(() => undefined);
  await waitFor('QEMU exit', () => !isRunning(vm), { timeoutMs: 15_000, intervalMs: 200 });
}

export async function destroy(vm: VmConfig) {
  await down(vm, { force: true });
  await removeSinks(vm.name);
  const { dir } = vmPaths(vm.name);
  if (!dir.startsWith(join(HOME, 'vms'))) throw new Error(`Refusing to delete ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

const CHECKPOINT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function checkName(name: string) {
  if (!CHECKPOINT_NAME.test(name)) {
    throw new UserError(`Bad checkpoint name '${name}'`, 'Use letters, digits, . _ -');
  }
}

export interface Checkpoint {
  name: string;
  vmStateSize: string;
  date: string;
}

export async function checkpointList(vm: VmConfig): Promise<Checkpoint[]> {
  const { disk, qmp } = vmPaths(vm.name);
  const text = isRunning(vm)
    ? await withQmp(qmp, (q) => q.hmp('info snapshots'))
    : (await run('qemu-img', ['snapshot', '-l', '-U', disk])).stdout;
  return parseSnapshotTable(text);
}

// Parses both `info snapshots` (HMP) and `qemu-img snapshot -l`; rows start with an id or "--".
export function parseSnapshotTable(text: string): Checkpoint[] {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 6 && /^(\d+|--)$/.test(cols[0]!))
    .map((cols) => ({
      name: cols[1]!,
      vmStateSize: `${cols[2]} ${cols[3]}`,
      date: `${cols[4]} ${cols[5]}`,
    }));
}

export async function checkpointSave(vm: VmConfig, name: string) {
  checkName(name);
  if (!isRunning(vm)) throw new UserError('The VM must be running to save a checkpoint');
  const { qmp } = vmPaths(vm.name);
  log(`Saving checkpoint '${name}'`);
  await closeMaster(vm);
  const out = await withQmp(qmp, (q) => q.hmp(`savevm ${name}`));
  if (out) throw new UserError(`savevm failed: ${out}`);
}

export async function checkpointRestore(vm: VmConfig, name: string) {
  checkName(name);
  if (!(await checkpointList(vm)).some((c) => c.name === name)) {
    throw new UserError(`No checkpoint named '${name}'`, `See: agent-vm checkpoint list`);
  }
  const p = vmPaths(vm.name);
  await closeMaster(vm);
  const out = await withQmp(p.qmp, (q) => q.hmp(`loadvm ${name}`));
  if (out) throw new UserError(`loadvm failed: ${out}`);
  // The guest wakes up believing it is still the moment the checkpoint was taken.
  await qga(p.qga, 'guest-set-time', { time: Date.now() * 1_000_000 }).catch((e: unknown) => {
    log(`Could not correct the guest clock: ${e instanceof Error ? e.message : String(e)}`);
  });
}

export async function checkpointDelete(vm: VmConfig, name: string) {
  checkName(name);
  const p = vmPaths(vm.name);
  if (isRunning(vm)) {
    const out = await withQmp(p.qmp, (q) => q.hmp(`delvm ${name}`));
    if (out) throw new UserError(`delvm failed: ${out}`);
  } else {
    await run('qemu-img', ['snapshot', '-d', name, p.disk]);
  }
}

export async function status(vm: VmConfig) {
  const running = isRunning(vm);
  const ssh = running ? await sshReachable(vm) : false;
  const desktop = ssh
    ? await desktopHealth(vm).then(
        (h) => h.ok,
        () => false,
      )
    : false;
  return {
    name: vm.name,
    running,
    pid: qemuPid(vm) ?? null,
    installed: vm.installed,
    ssh,
    desktop,
    ports: vm.ports,
    spice: `spice://127.0.0.1:${vm.ports.spice}`,
    cpus: vm.cpus,
    memoryGb: vm.memoryGb,
    checkpoints: (await checkpointList(vm).catch(() => [])).map((c) => c.name),
  };
}
