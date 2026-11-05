import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.ts reads AGENT_VM_HOME at import time, so set it before importing.
const home = mkdtempSync(join(tmpdir(), 'agent-vm-home-'));
process.env.AGENT_VM_HOME = home;
delete process.env.AGENT_VM;
const state = await import('../state.js');

const vm = (name: string) => ({
  name,
  os: 'windows' as const,
  cpus: 2,
  memoryGb: 4,
  diskGb: 40,
  resolution: { width: 1280, height: 800 },
  tpm: false,
  user: 'agent',
  password: 'agent-vm',
  ports: { ssh: 22220, spice: 5930, agentd: 17777, cdp: 19222 },
  iso: '/tmp/x.iso',
  installed: false,
});

describe('VM state', () => {
  before(() => {
    state.ensureDirs();
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('explains how to create the first VM', () => {
    assert.throws(() => state.resolveVmName(), /No VMs yet/);
  });

  it('saves, loads and picks the only VM by default', () => {
    state.saveVm(vm('alpha'));
    assert.equal(state.resolveVmName(), 'alpha');
    assert.equal(state.loadVm('alpha').cpus, 2);
  });

  it('asks which VM when there are several', () => {
    state.saveVm(vm('beta'));
    assert.throws(() => state.resolveVmName(), /Several VMs/);
    assert.equal(state.resolveVmName('beta'), 'beta');
    process.env.AGENT_VM = 'alpha';
    assert.equal(state.resolveVmName(), 'alpha');
    delete process.env.AGENT_VM;
  });

  it('lists known VMs when a name is wrong', () => {
    assert.throws(
      () => state.loadVm('gamma'),
      (e: Error & { hint?: string }) => (e.hint ?? '').includes('alpha, beta'),
    );
  });
});
