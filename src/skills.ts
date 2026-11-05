import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './util.js';

export const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export type SkillTarget = 'claude' | 'codex';

export function listSkills(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name);
}

export function skillPath(name = 'agent-vm'): string {
  const dir = join(SKILLS_DIR, name);
  if (!existsSync(join(dir, 'SKILL.md'))) {
    throw new UserError(`No skill named '${name}'`, `Available: ${listSkills().join(', ')}`);
  }
  return dir;
}

export function readSkill(name = 'agent-vm'): string {
  return readFileSync(join(skillPath(name), 'SKILL.md'), 'utf8');
}

// Where each agent looks for skills: per user, or inside a project when `project` is given.
export function skillRoot(target: SkillTarget, project?: string): string {
  if (project !== undefined) {
    return join(resolve(project), target === 'claude' ? '.claude/skills' : '.agents/skills');
  }
  if (target === 'claude') return join(homedir(), '.claude', 'skills');
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills');
}

// Copies rather than symlinks, so the installed skill survives `npm uninstall` and works in
// sandboxes that cannot see the global node_modules. Re-run after upgrading agent-vm.
export function installSkill(target: SkillTarget, project?: string): string {
  const dest = join(skillRoot(target, project), 'agent-vm');
  mkdirSync(dest, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(skillPath(), dest, { recursive: true });
  return dest;
}
