import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { charToKeys, parseCombo, pngSize } from '../input.js';

describe('charToKeys', () => {
  it('maps letters, digits and shifted characters', () => {
    assert.deepEqual(charToKeys('a'), ['a']);
    assert.deepEqual(charToKeys('Z'), ['shift', 'z']);
    assert.deepEqual(charToKeys('7'), ['7']);
    assert.deepEqual(charToKeys('!'), ['shift', '1']);
    assert.deepEqual(charToKeys(' '), ['spc']);
    assert.deepEqual(charToKeys('\n'), ['ret']);
    assert.deepEqual(charToKeys(':'), ['shift', 'semicolon']);
  });

  it('refuses characters the US layout cannot type', () => {
    assert.throws(() => charToKeys('å'), /Cannot type/);
  });
});

describe('parseCombo', () => {
  it('understands modifiers and aliases', () => {
    assert.deepEqual(parseCombo('ctrl+alt+delete'), ['ctrl', 'alt', 'delete']);
    assert.deepEqual(parseCombo('Win+R'), ['meta_l', 'r']);
    assert.deepEqual(parseCombo('enter'), ['ret']);
    assert.deepEqual(parseCombo('f12'), ['f12']);
  });

  it('rejects unknown keys', () => {
    assert.throws(() => parseCombo('ctrl+hyper'), /Unknown key/);
  });
});

describe('pngSize', () => {
  it('reads the IHDR dimensions', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    assert.deepEqual(pngSize(png), { width: 1920, height: 1080 });
  });
});
