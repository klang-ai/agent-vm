import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE } from './state.js';
import { log, runInherit, UserError } from './util.js';

// Pinned where upstream publishes versioned URLs, so a VM built today is reproducible; bump
// deliberately. The Windows ISO, virtio-win and the VC++ runtime only have "latest" links.
export const ASSETS = {
  windows11Eval: {
    file: 'Win11_24H2_Enterprise_Eval_x64_en-us.iso',
    url: 'https://go.microsoft.com/fwlink/?linkid=2289031&clcid=0x409&culture=en-us&country=us',
    minBytes: 4_000_000_000,
  },
  virtioWin: {
    file: 'virtio-win.iso',
    url: 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso',
    minBytes: 400_000_000,
  },
  openssh: {
    file: 'OpenSSH-Win64-v10.4.0.0.msi',
    url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.4.0.0p1-Preview/OpenSSH-Win64-v10.4.0.0.msi',
    minBytes: 1_000_000,
  },
  node: {
    file: 'node-v24.22.2-x64.msi',
    url: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-x64.msi',
    minBytes: 10_000_000,
  },
  ffmpeg: {
    file: 'ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
    minBytes: 30_000_000,
  },
  // Many native tools (agent-desktop among them) need VCRUNTIME140.dll, which Windows lacks.
  vcRedist: {
    file: 'vc_redist.x64.exe',
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    minBytes: 10_000_000,
  },
} as const;

export type AssetName = keyof typeof ASSETS;

export async function fetchAsset(name: AssetName): Promise<string> {
  const asset = ASSETS[name];
  const path = join(CACHE, asset.file);
  if (existsSync(path) && statSync(path).size >= asset.minBytes) return path;
  log(`Downloading ${asset.file}`);
  // curl's default user agent matters: some mirrors (fedorapeople) serve a bot challenge to browser UAs.
  const partial = `${path}.part`;
  const code = await runInherit('curl', ['-fL', '--retry', '5', '-C', '-', '-#', '-o', partial, asset.url]);
  if (code !== 0) throw new UserError(`Download failed: ${asset.url}`);
  if (statSync(partial).size < asset.minBytes) {
    throw new UserError(`Download of ${asset.file} is too small; the server probably returned an error page`);
  }
  renameSync(partial, path);
  return path;
}
