import { existsSync, readFileSync, rmSync } from 'node:fs';
import { CACHE, vmPaths, type VmConfig } from './state.js';
import { join } from 'node:path';
import { log, run, UserError, waitFor } from './util.js';
import { micSinkName, speakerSinkName } from './audio.js';

const OVMF_CODE_CANDIDATES = [
  '/usr/share/OVMF/OVMF_CODE_4M.fd',
  '/usr/share/edk2/x64/OVMF_CODE.4m.fd',
  '/usr/share/edk2/ovmf/OVMF_CODE.fd',
  '/usr/share/OVMF/OVMF_CODE.fd',
];
const OVMF_VARS_CANDIDATES = [
  '/usr/share/OVMF/OVMF_VARS_4M.fd',
  '/usr/share/edk2/x64/OVMF_VARS.4m.fd',
  '/usr/share/edk2/ovmf/OVMF_VARS.fd',
  '/usr/share/OVMF/OVMF_VARS.fd',
];

function firstExisting(candidates: string[], what: string): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new UserError(`${what} not found`, 'Install OVMF (Debian/Ubuntu: apt install ovmf)');
  return found;
}

export const ovmfCode = () => firstExisting(OVMF_CODE_CANDIDATES, 'OVMF firmware');
export const ovmfVars = () => firstExisting(OVMF_VARS_CANDIDATES, 'OVMF variable store');

export function qemuPid(vm: VmConfig): number | undefined {
  const { pid } = vmPaths(vm.name);
  if (!existsSync(pid)) return undefined;
  const value = Number(readFileSync(pid, 'utf8').trim());
  try {
    process.kill(value, 0);
    return value;
  } catch {
    return undefined;
  }
}

export function isRunning(vm: VmConfig) {
  return qemuPid(vm) !== undefined;
}

// virtio-vga, not qxl: QEMU's screendump cannot see qxl's native mode, so host screenshots of
// a running Windows desktop come out black.
// Every device here must support live migration, because checkpoints are QEMU snapshots
// (savevm): no invtsc or hv-passthrough, and the UEFI variable store is qcow2, not raw.
export function qemuArgs(vm: VmConfig, { install }: { install: boolean }): string[] {
  const p = vmPaths(vm.name);
  const hyperv = [
    'hv-relaxed',
    'hv-vapic',
    'hv-spinlocks=0x1fff',
    'hv-vpindex',
    'hv-runtime',
    'hv-synic',
    'hv-stimer',
    'hv-time',
    'hv-tlbflush',
    'hv-ipi',
  ];
  const args = [
    '-name',
    `agent-vm-${vm.name},process=agent-vm-${vm.name}`,
    '-machine',
    'q35,accel=kvm,smm=off,vmport=off',
    '-cpu',
    ['host', ...hyperv].join(','),
    '-smp',
    String(vm.cpus),
    '-m',
    `${vm.memoryGb}G`,
    '-rtc',
    'base=localtime,clock=host,driftfix=slew',
    '-global',
    'kvm-pit.lost_tick_policy=discard',
    '-global',
    'ICH9-LPC.disable_s3=1',
    '-drive',
    `if=pflash,format=raw,unit=0,readonly=on,file=${ovmfCode()}`,
    '-drive',
    `if=pflash,format=qcow2,unit=1,file=${p.efiVars}`,
    '-device',
    'virtio-blk-pci,drive=disk0,bootindex=1',
    '-drive',
    `id=disk0,if=none,format=qcow2,discard=unmap,file=${p.disk}`,
    '-device',
    'virtio-net-pci,netdev=net0',
    '-netdev',
    `user,id=net0,hostfwd=tcp:127.0.0.1:${vm.ports.ssh}-:22`,
    '-device',
    `virtio-vga,xres=${vm.resolution.width},yres=${vm.resolution.height}`,
    '-device',
    'qemu-xhci,id=xhci',
    '-device',
    'usb-tablet,bus=xhci.0',
    '-device',
    'virtio-rng-pci',
    // hda-micro presents the input as a microphone; hda-duplex would show up as "Line In".
    '-audiodev',
    `pa,id=snd0,in.name=${micSinkName(vm.name)}.monitor,out.name=${speakerSinkName(vm.name)}`,
    '-device',
    'ich9-intel-hda,id=hda',
    '-device',
    'hda-micro,audiodev=snd0,bus=hda.0',
    '-device',
    'virtio-serial-pci',
    '-chardev',
    `socket,id=qga0,path=${p.qga},server=on,wait=off`,
    '-device',
    'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
    '-chardev',
    'spicevmc,id=vdagent,name=vdagent',
    '-device',
    'virtserialport,chardev=vdagent,name=com.redhat.spice.0',
    '-spice',
    `port=${vm.ports.spice},addr=127.0.0.1,disable-ticketing=on`,
    '-display',
    'none',
    '-qmp',
    `unix:${p.qmp},server=on,wait=off`,
    '-monitor',
    'none',
    '-serial',
    'none',
    '-pidfile',
    p.pid,
    '-daemonize',
  ];
  if (vm.tpm) {
    args.push(
      '-chardev',
      `socket,id=chrtpm,path=${p.tpmSock}`,
      '-tpmdev',
      'emulator,id=tpm0,chardev=chrtpm',
      '-device',
      'tpm-tis,tpmdev=tpm0',
    );
  }
  // Media stays attached after install so drive letters never shift; read-only media does
  // not block snapshots.
  args.push(
    '-drive',
    `media=cdrom,index=0,readonly=on,file=${install ? vm.iso : join(CACHE, 'virtio-win.iso')}`,
    '-drive',
    `media=cdrom,index=1,readonly=on,file=${join(CACHE, 'virtio-win.iso')}`,
    '-drive',
    `media=cdrom,index=2,readonly=on,file=${p.unattendIso}`,
  );
  return args;
}

async function startTpm(vm: VmConfig) {
  const p = vmPaths(vm.name);
  rmSync(p.tpmSock, { force: true });
  await run('swtpm', [
    'socket',
    '--tpmstate',
    `dir=${p.tpmDir}`,
    '--ctrl',
    `type=unixio,path=${p.tpmSock}`,
    '--tpm2',
    '--daemon',
    '--pid',
    `file=${p.tpmPid}`,
    '--log',
    `file=${join(p.dir, 'swtpm.log')}`,
    '--terminate',
  ]);
  await waitFor('swtpm socket', () => existsSync(p.tpmSock), { timeoutMs: 10_000, intervalMs: 100 });
}

export async function startQemu(vm: VmConfig, { install = false } = {}) {
  const p = vmPaths(vm.name);
  if (isRunning(vm)) return;
  rmSync(p.qmp, { force: true });
  if (vm.tpm) await startTpm(vm);
  const args = qemuArgs(vm, { install });
  log(`Starting ${vm.name}`);
  const result = await run('qemu-system-x86_64', args, { check: false });
  if (result.code !== 0) {
    throw new UserError(`QEMU failed to start: ${result.stderr.trim()}`);
  }
  await waitFor('QMP socket', () => existsSync(p.qmp), { timeoutMs: 15_000, intervalMs: 200 });
}
