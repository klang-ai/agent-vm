import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { micSinkName, speakerSinkName, wavLevel } from '../audio.js';

function wav(
  samples: number[],
  { sampleRate = 16000, dataSize }: { sampleRate?: number; dataSize?: number } = {},
) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize ?? data.length, 40);
  return Buffer.concat([header, data]);
}

const sine = (n: number, amplitude: number) =>
  Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000));

describe('wavLevel', () => {
  it('reports silence as silent', () => {
    const level = wavLevel(wav(new Array<number>(16000).fill(0)));
    assert.equal(level.silent, true);
    assert.equal(level.durationSec, 1);
    assert.equal(level.peak, 0);
  });

  it('measures a sine wave', () => {
    const level = wavLevel(wav(sine(16000, 0.5)));
    assert.equal(level.silent, false);
    assert.ok(Math.abs(level.rms - 0.5 / Math.SQRT2) < 0.01, `rms ${level.rms}`);
    assert.ok(Math.abs(level.rmsDbfs - -9.03) < 0.2, `dBFS ${level.rmsDbfs}`);
    assert.ok(level.peak > 0.49 && level.peak <= 0.5);
  });

  it('treats very quiet noise as silent', () => {
    assert.equal(wavLevel(wav(sine(16000, 0.001))).silent, true);
  });

  it('reads files from streaming writers whose data size is unset', () => {
    for (const dataSize of [0, 0xffffffff]) {
      const level = wavLevel(wav(sine(8000, 0.5), { dataSize }));
      assert.equal(level.durationSec, 0.5);
      assert.equal(level.silent, false);
    }
  });

  it('rejects non-WAV input', () => {
    assert.throws(() => wavLevel(Buffer.from('not a wav file at all, definitely not')), /Not a WAV/);
  });
});

describe('sink names', () => {
  it('are stable and safe for PulseAudio', () => {
    assert.equal(micSinkName('win11'), 'agentvm_win11_mic');
    assert.equal(speakerSinkName('my vm.2'), 'agentvm_my_vm_2_speaker');
  });
});
