import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'agent-vm-cli-'));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_VM_HOME: home, AGENT_VM: '' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli', () => {
  it('points agents at the skill and documents exit codes', () => {
    const r = run('--help');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Start here \(for AI agents\)/);
    assert.match(r.stdout, /Exit codes:/);
  });

  it('shows examples in command help', () => {
    for (const command of ['exec', 'launch', 'ui', 'mic', 'checkpoint', 'skills']) {
      assert.match(run('help', command).stdout, /Examples:\n {2}\$ agent-vm /, command);
    }
  });

  it('exits 2 on usage errors and suggests the right command', () => {
    const r = run('screnshot');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Did you mean screenshot\?/);
    assert.ok(r.stderr.split('\n').length < 6, 'no full help dump on a typo');
  });

  it('reports errors as JSON with --json', () => {
    const usage = run('--json', 'mic', 'say');
    assert.equal(usage.code, 2);
    assert.equal((JSON.parse(usage.stdout) as { error: { reason: string } }).error.reason, 'usage');

    const failed = run('--json', 'status', '--vm', 'nope');
    assert.equal(failed.code, 1);
    const error = (JSON.parse(failed.stdout) as { error: { reason: string; message: string } }).error;
    assert.equal(error.reason, 'failed');
    assert.match(error.message, /nope/);
  });

  it('prints and installs the bundled skill for Claude Code and Codex', () => {
    assert.match(run('skills', 'get').stdout, /^---\nname: agent-vm\n/);
    const project = mkdtempSync(join(tmpdir(), 'agent-vm-project-'));
    const r = run('--json', 'skills', 'install', '--project', project);
    assert.equal(r.code, 0);
    for (const dir of ['.claude/skills/agent-vm', '.agents/skills/agent-vm']) {
      const skill = join(project, dir, 'SKILL.md');
      assert.ok(existsSync(skill), dir);
      assert.match(readFileSync(skill, 'utf8'), /name: agent-vm/);
    }
  });
});
