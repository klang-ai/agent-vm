import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.ts reads AGENT_VM_HOME at import time, so set it before importing.
const home = mkdtempSync(join(tmpdir(), 'agent-vm-images-'));
process.env.AGENT_VM_HOME = home;
const state = await import('../state.js');
const images = await import('../images.js');

state.ensureDirs();
writeFileSync(join(home, 'id_ed25519.pub'), 'ssh-ed25519 AAAA test\n');
const iso = join(home, 'win.iso');
writeFileSync(iso, 'iso');
const inputs = { iso, locale: 'en-US', timeZone: 'UTC', diskGb: 80 };

describe('cached images', () => {
  it('keys an install by what is baked into the disk', () => {
    const key = images.imageKey(inputs);
    assert.match(key, /^[0-9a-f]{16}$/);
    assert.equal(images.imageKey({ ...inputs }), key);
    assert.notEqual(images.imageKey({ ...inputs, locale: 'sv-SE' }), key);
    assert.notEqual(images.imageKey({ ...inputs, diskGb: 120 }), key);
  });

  it('refuses to delete an image a VM is built on', () => {
    const key = images.imageKey(inputs);
    const img = images.imagePaths(key);
    mkdirSync(img.dir, { recursive: true });
    writeFileSync(img.meta, JSON.stringify({ key, ...inputs, createdAt: '', fromVm: 'a' }));
    mkdirSync(state.vmDir('b'), { recursive: true });
    state.saveVm({
      name: 'b',
      os: 'windows',
      cpus: 2,
      memoryGb: 4,
      diskGb: 80,
      resolution: { width: 1280, height: 800 },
      tpm: false,
      user: 'agent',
      password: 'agent-vm',
      ports: { ssh: 1, spice: 2, agentd: 3, cdp: 4 },
      iso,
      installed: true,
      baseImage: key,
    });
    assert.deepEqual(images.listImages()[0]?.usedBy, ['b']);
    assert.throws(() => {
      images.deleteImage(key);
    }, /backs b/);
  });
});
