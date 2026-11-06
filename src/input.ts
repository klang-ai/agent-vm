import { readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Qmp } from './qmp.js';
import { UserError } from './util.js';

// Host-side input and capture through QMP. Works with no guest software at all, which makes
// it the fallback for a wedged guest, the login screen, or setup screens before SSH exists.

const SHIFTED: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: 'minus',
  '+': 'equal',
  '{': 'bracket_left',
  '}': 'bracket_right',
  '|': 'backslash',
  ':': 'semicolon',
  '"': 'apostrophe',
  '~': 'grave_accent',
  '<': 'comma',
  '>': 'dot',
  '?': 'slash',
};
const PLAIN: Record<string, string> = {
  ' ': 'spc',
  '\n': 'ret',
  '\t': 'tab',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracket_left',
  ']': 'bracket_right',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave_accent',
  ',': 'comma',
  '.': 'dot',
  '/': 'slash',
};
const KEY_ALIASES: Record<string, string> = {
  plus: 'equal',
  equal: 'equal',
  minus: 'minus',
  enter: 'ret',
  return: 'ret',
  esc: 'esc',
  escape: 'esc',
  space: 'spc',
  backspace: 'backspace',
  del: 'delete',
  delete: 'delete',
  win: 'meta_l',
  super: 'meta_l',
  cmd: 'meta_l',
  meta: 'meta_l',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pgup: 'pgup',
  pgdn: 'pgdn',
};

// US layout: the guest maps scancodes, so text is only exact while the guest keyboard is en-US.
export function charToKeys(ch: string): string[] {
  if (/^[a-z0-9]$/.test(ch)) return [ch];
  if (/^[A-Z]$/.test(ch)) return ['shift', ch.toLowerCase()];
  if (PLAIN[ch]) return [PLAIN[ch]];
  if (SHIFTED[ch]) return ['shift', SHIFTED[ch]];
  throw new UserError(`Cannot type '${ch}' with host input`, 'Use `agent-vm ui type` for non-ASCII text');
}

export function parseCombo(combo: string): string[] {
  return combo
    .toLowerCase()
    .split('+')
    .map((part) => {
      const key = part.trim();
      if (KEY_ALIASES[key]) return KEY_ALIASES[key];
      if (PLAIN[key] && key.trim()) return PLAIN[key];
      if (Object.values(PLAIN).includes(key)) return key;
      if (/^f([1-9]|1[0-2])$/.test(key) || /^[a-z0-9]$/.test(key)) return key;
      throw new UserError(`Unknown key '${part}'`);
    });
}

const keyEvent = (key: string, down: boolean) => ({
  type: 'key',
  data: { down, key: { type: 'qcode', data: key } },
});

export async function keysDown(qmp: Qmp, keys: string[]) {
  await qmp.execute('input-send-event', { events: keys.map((k) => keyEvent(k, true)) });
}

export async function keysUp(qmp: Qmp, keys: string[]) {
  await qmp.execute('input-send-event', { events: [...keys].reverse().map((k) => keyEvent(k, false)) });
}

export async function pressKeys(qmp: Qmp, keys: string[]) {
  await keysDown(qmp, keys);
  await keysUp(qmp, keys);
}

export async function typeText(qmp: Qmp, text: string, delayMs = 15) {
  for (const ch of text) {
    await pressKeys(qmp, charToKeys(ch));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

const ABS_MAX = 0x7fff;

export async function click(
  qmp: Qmp,
  x: number,
  y: number,
  screen: { width: number; height: number },
  { button = 'left', double = false } = {},
) {
  const abs = (axis: 'x' | 'y', value: number, size: number) => ({
    type: 'abs',
    data: { axis, value: Math.round((value / size) * ABS_MAX) },
  });
  const btn = (down: boolean) => ({ type: 'btn', data: { down, button } });
  await qmp.execute('input-send-event', { events: [abs('x', x, screen.width), abs('y', y, screen.height)] });
  for (let i = 0; i < (double ? 2 : 1); i++) {
    await qmp.execute('input-send-event', { events: [btn(true)] });
    await qmp.execute('input-send-event', { events: [btn(false)] });
  }
}

export function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function screenshot(qmp: Qmp, out: string): Promise<{ width: number; height: number }> {
  // QEMU writes the file itself, so write next to the target and rename for atomicity.
  const tmp = join(dirname(out), `.agent-vm-shot-${process.pid}.png`);
  try {
    await qmp.execute('screendump', { filename: tmp, format: 'png' });
    const size = pngSize(readFileSync(tmp));
    renameSync(tmp, out);
    return size;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function screenSize(qmp: Qmp, scratchDir: string) {
  const tmp = join(scratchDir, `.agent-vm-size-${process.pid}.png`);
  try {
    await qmp.execute('screendump', { filename: tmp, format: 'png' });
    return pngSize(readFileSync(tmp));
  } finally {
    rmSync(tmp, { force: true });
  }
}
