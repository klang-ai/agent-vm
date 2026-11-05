import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserError } from './util.js';

export const HOME = process.env.AGENT_VM_HOME ?? join(homedir(), '.agent-vm');
export const CACHE = join(HOME, 'cache');
export const VMS = join(HOME, 'vms');
export const SSH_KEY = join(HOME, 'id_ed25519');

export interface VmConfig {
  name: string;
  os: 'windows';
  cpus: number;
  memoryGb: number;
  diskGb: number;
  resolution: { width: number; height: number };
  tpm: boolean;
  user: string;
  password: string;
  ports: { ssh: number; spice: number; agentd: number; cdp: number };
  iso: string;
  installed: boolean;
  /** What a base image saved from this VM would be keyed by; unset for TPM VMs. */
  image?: { key: string; inputs: import('./images.js').ImageInputs };
  /** Key of the base image this VM's disk is an overlay on. */
  baseImage?: string;
}

export function vmDir(name: string) {
  return join(VMS, name);
}

export function vmPaths(name: string) {
  const dir = vmDir(name);
  return {
    dir,
    config: join(dir, 'vm.json'),
    disk: join(dir, 'disk.qcow2'),
    efiVars: join(dir, 'efivars.qcow2'),
    tpmDir: join(dir, 'tpm'),
    tpmSock: join(dir, 'swtpm.sock'),
    tpmPid: join(dir, 'swtpm.pid'),
    qmp: join(dir, 'qmp.sock'),
    qga: join(dir, 'qga.sock'),
    pid: join(dir, 'qemu.pid'),
    log: join(dir, 'qemu.log'),
    unattendIso: join(dir, 'unattend.iso'),
    sshControl: join(dir, 'ssh.ctl'),
    agentdToken: join(dir, 'agentd.token'),
  };
}

export function ensureDirs() {
  for (const dir of [HOME, CACHE, VMS]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(HOME, 0o700);
}

export function loadVm(name: string): VmConfig {
  const { config } = vmPaths(name);
  if (!existsSync(config)) {
    const known = listVms();
    throw new UserError(
      `No VM named '${name}'`,
      known.length ? `Known VMs: ${known.join(', ')}` : `Create one with: agent-vm create ${name}`,
    );
  }
  return JSON.parse(readFileSync(config, 'utf8')) as VmConfig;
}

export function saveVm(vm: VmConfig) {
  const paths = vmPaths(vm.name);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(vm, null, 2) + '\n');
}

export function listVms(): string[] {
  if (!existsSync(VMS)) return [];
  return readdirSync(VMS).filter((name) => existsSync(vmPaths(name).config));
}

export function resolveVmName(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AGENT_VM) return process.env.AGENT_VM;
  const vms = listVms();
  if (vms.length === 1) return vms[0]!;
  if (vms.length === 0) throw new UserError('No VMs yet', 'Create one with: agent-vm create win11');
  throw new UserError(
    `Several VMs exist (${vms.join(', ')})`,
    'Pick one with --vm <name> or AGENT_VM=<name>',
  );
}
