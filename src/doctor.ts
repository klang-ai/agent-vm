import { accessSync, constants, existsSync } from 'node:fs';
import { listVms, loadVm, resolveVmName } from './state.js';
import { run, which } from './util.js';
import { status } from './vm.js';
import { ovmfCode } from './qemu.js';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const tool = (name: string, why: string): Check => ({ name: `${name} (${why})`, ok: Boolean(which(name)) });

export async function doctor(vmName?: string): Promise<Check[]> {
  const checks: Check[] = [];
  let kvm = false;
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    kvm = true;
  } catch {
    // reported below
  }
  checks.push({
    name: '/dev/kvm usable',
    ok: kvm,
    detail: kvm ? undefined : 'add yourself to the kvm group',
  });
  checks.push(
    tool('qemu-system-x86_64', 'runs the VM'),
    tool('qemu-img', 'disks and checkpoints'),
    tool('xorriso', 'builds the unattend ISO'),
    tool('ssh', 'guest shell'),
    tool('scp', 'file copy'),
    tool('curl', 'downloads'),
    tool('pactl', 'virtual audio devices'),
    tool('pw-play', 'microphone playback'),
    tool('parecord', 'speaker recording'),
  );
  let ovmf: string | undefined;
  try {
    ovmf = ovmfCode();
  } catch {
    // reported below
  }
  checks.push({ name: 'OVMF UEFI firmware', ok: Boolean(ovmf), detail: ovmf });
  const tts = which('piper')
    ? 'piper'
    : which('espeak-ng')
      ? 'espeak-ng (install piper for natural speech)'
      : undefined;
  checks.push({ name: 'text-to-speech for `mic say`', ok: Boolean(tts), detail: tts });
  checks.push({
    name: 'agent-browser (for `web`, optional)',
    ok: true,
    detail: which('agent-browser') ? 'installed' : 'not installed',
  });
  if (which('pactl')) {
    const info = await run('pactl', ['info'], { check: false });
    checks.push({
      name: 'audio server reachable',
      ok: info.code === 0,
      detail: /Server Name: (.*)/.exec(info.stdout)?.[1],
    });
  }

  const names = vmName ? [vmName] : listVms().length === 1 ? [resolveVmName()] : [];
  for (const name of names) {
    const vm = loadVm(name);
    const s = await status(vm);
    checks.push({ name: `${name}: ISO present`, ok: existsSync(vm.iso) || vm.installed });
    checks.push({ name: `${name}: installed`, ok: s.installed });
    if (s.running) {
      checks.push({ name: `${name}: SSH`, ok: s.ssh });
      checks.push({ name: `${name}: desktop agent`, ok: s.desktop });
    } else {
      checks.push({ name: `${name}: running`, ok: true, detail: 'stopped (start with `agent-vm up`)' });
    }
  }
  return checks;
}
