import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CACHE, listVms, loadVm, SSH_KEY, vmPaths, type VmConfig } from './state.js';
import { run, UserError } from './util.js';

// Installed-and-bootstrapped Windows disks, reused as read-only qcow2 backing files so a new VM
// takes about a minute instead of a full unattended install.
export const IMAGES = join(CACHE, 'images');

// Bump when the guest setup changes in a way old images lack (firstboot, bootstrap layout).
const FORMAT = 1;

export interface ImageInputs {
  iso: string;
  locale: string;
  timeZone: string;
  productKey?: string;
  diskGb: number;
}

export interface ImageMeta extends ImageInputs {
  key: string;
  createdAt: string;
  fromVm: string;
}

// Everything that ends up baked into the installed disk. CPUs, memory, resolution and ports are
// runtime settings and stay out of it.
export function imageKey(inputs: ImageInputs): string {
  const iso = statSync(inputs.iso);
  const sshKey = readFileSync(`${SSH_KEY}.pub`, 'utf8').trim();
  const material = JSON.stringify([
    FORMAT,
    inputs.iso,
    iso.size,
    iso.mtimeMs,
    inputs.locale,
    inputs.timeZone,
    inputs.productKey ?? '',
    inputs.diskGb,
    sshKey,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function imagePaths(key: string) {
  const dir = join(IMAGES, key);
  return {
    dir,
    disk: join(dir, 'disk.qcow2'),
    efiVars: join(dir, 'efivars.qcow2'),
    meta: join(dir, 'image.json'),
  };
}

export function hasImage(key: string): boolean {
  return existsSync(imagePaths(key).meta);
}

export function listImages(): (ImageMeta & { usedBy: string[] })[] {
  if (!existsSync(IMAGES)) return [];
  const users = listVms().map(loadVm);
  return readdirSync(IMAGES)
    .filter(hasImage)
    .map((key) => {
      const meta = JSON.parse(readFileSync(imagePaths(key).meta, 'utf8')) as ImageMeta;
      return { ...meta, usedBy: users.filter((vm) => vm.baseImage === key).map((vm) => vm.name) };
    });
}

// The VM must be shut down. Copies only the disk's current state, not its checkpoints.
export async function saveImage(vm: VmConfig): Promise<string> {
  if (!vm.image) {
    throw new UserError(
      `${vm.name} cannot be saved as an image`,
      'TPM VMs and VMs from older versions are not cached',
    );
  }
  const { key, inputs } = vm.image;
  if (vm.baseImage === key) return key;
  const existing = listImages().find((i) => i.key === key);
  if (existing?.usedBy.length) {
    throw new UserError(
      `Image ${key} already backs ${existing.usedBy.join(', ')}`,
      'It cannot be replaced while in use',
    );
  }
  const p = vmPaths(vm.name);
  const img = imagePaths(key);
  const tmp = `${img.dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await run('qemu-img', ['convert', '-O', 'qcow2', p.disk, join(tmp, 'disk.qcow2')]);
  await run('qemu-img', ['convert', '-O', 'qcow2', p.efiVars, join(tmp, 'efivars.qcow2')]);
  const meta: ImageMeta = { key, ...inputs, createdAt: new Date().toISOString(), fromVm: vm.name };
  writeFileSync(join(tmp, 'image.json'), JSON.stringify(meta, null, 2) + '\n');
  // Overlays point at the backing file by path, so it must never change underneath them.
  chmodSync(join(tmp, 'disk.qcow2'), 0o444);
  rmSync(img.dir, { recursive: true, force: true });
  renameSync(tmp, img.dir);
  return key;
}

export async function createFromImage(vm: VmConfig, key: string) {
  const p = vmPaths(vm.name);
  const img = imagePaths(key);
  await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', img.disk, '-F', 'qcow2', p.disk]);
  await run('qemu-img', ['convert', '-O', 'qcow2', img.efiVars, p.efiVars]);
}

export function deleteImage(key: string) {
  const image = listImages().find((i) => i.key === key);
  if (!image) throw new UserError(`No image '${key}'`, 'See: agent-vm image list');
  if (image.usedBy.length) {
    throw new UserError(
      `Image ${key} backs ${image.usedBy.join(', ')}`,
      `Destroy ${image.usedBy.length > 1 ? 'those VMs' : 'that VM'} first`,
    );
  }
  rmSync(imagePaths(key).dir, { recursive: true, force: true });
}
