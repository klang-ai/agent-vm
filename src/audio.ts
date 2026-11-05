import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { CACHE } from './state.js';
import { log, run, runInherit, UserError, which } from './util.js';

// Each VM gets two PipeWire/PulseAudio null sinks. Whatever is played into the "mic" sink is
// what the guest's microphone hears (QEMU records its monitor); the guest's speakers play into
// the "speaker" sink, so guest audio never reaches the host's real speakers and can be recorded.
const slug = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '_');
export const micSinkName = (vm: string) => `agentvm_${slug(vm)}_mic`;
export const speakerSinkName = (vm: string) => `agentvm_${slug(vm)}_speaker`;

async function sinkNames(): Promise<string[]> {
  const { stdout } = await run('pactl', ['list', 'short', 'sinks']);
  return stdout
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((name): name is string => Boolean(name));
}

export async function ensureSinks(vm: string) {
  if (!which('pactl')) {
    throw new UserError(
      'pactl not found',
      'agent-vm needs PipeWire (pipewire-pulse) or PulseAudio on the host',
    );
  }
  const existing = await sinkNames();
  const { stdout: defaultSink } = await run('pactl', ['get-default-sink']);
  for (const [sink, description] of [
    [micSinkName(vm), `agent-vm ${vm} microphone`],
    [speakerSinkName(vm), `agent-vm ${vm} speaker`],
  ] as const) {
    if (existing.includes(sink)) continue;
    await run('pactl', [
      'load-module',
      'module-null-sink',
      `sink_name=${sink}`,
      'rate=48000',
      `sink_properties=device.description="${description}"`,
    ]);
  }
  // A new sink must never steal the host's default output.
  const { stdout: after } = await run('pactl', ['get-default-sink']);
  if (after.trim() !== defaultSink.trim() && defaultSink.trim()) {
    await run('pactl', ['set-default-sink', defaultSink.trim()]);
  }
}

export async function removeSinks(vm: string) {
  const { stdout } = await run('pactl', ['list', 'short', 'modules']);
  for (const line of stdout.split('\n')) {
    const [id, module, args = ''] = line.split('\t');
    if (module !== 'module-null-sink') continue;
    if (args.includes(`sink_name=${micSinkName(vm)}`) || args.includes(`sink_name=${speakerSinkName(vm)}`)) {
      await run('pactl', ['unload-module', id!]);
    }
  }
}

const NATIVE_FORMATS = new Set(['.wav', '.flac', '.ogg', '.oga']);

export async function playIntoMic(vm: string, file: string) {
  if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
  await ensureSinks(vm);
  let source = file;
  let tmp: string | undefined;
  if (!NATIVE_FORMATS.has(extname(file).toLowerCase())) {
    tmp = mkdtempSync(join(tmpdir(), 'agent-vm-'));
    source = join(tmp, 'audio.wav');
    await run('ffmpeg', ['-loglevel', 'error', '-i', file, '-ar', '48000', '-ac', '1', source]);
  }
  try {
    const code = await runInherit('pw-play', ['--target', micSinkName(vm), source]);
    if (code !== 0) throw new UserError(`pw-play exited ${code}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

const PIPER_VOICES: Record<string, string> = {
  sv: 'sv/sv_SE/nst/medium/sv_SE-nst-medium',
  en: 'en/en_US/lessac/medium/en_US-lessac-medium',
  da: 'da/da_DK/talesyntese/medium/da_DK-talesyntese-medium',
  no: 'no/no_NO/talesyntese/medium/no_NO-talesyntese-medium',
  de: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium',
};

async function piperModel(lang: string): Promise<string | undefined> {
  const voice = PIPER_VOICES[lang];
  if (!voice) return undefined;
  const base = voice.split('/').pop()!;
  const model = join(CACHE, 'piper', `${base}.onnx`);
  if (existsSync(model) && existsSync(`${model}.json`)) return model;
  const url = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${voice}`;
  log(`Downloading piper voice ${base}`);
  await run('mkdir', ['-p', join(CACHE, 'piper')]);
  await run('curl', ['-fsSL', '-o', model, `${url}.onnx`]);
  await run('curl', ['-fsSL', '-o', `${model}.json`, `${url}.onnx.json`]);
  return model;
}

export async function synthesize(text: string, out: string, { lang = 'en' } = {}): Promise<string> {
  const piper = which('piper');
  if (piper) {
    const model = await piperModel(lang);
    if (model) {
      await run(piper, ['--model', model, '--output_file', out], { input: text });
      return 'piper';
    }
  }
  if (!which('espeak-ng')) {
    throw new UserError('No text-to-speech engine', 'Install piper (pipx install piper-tts) or espeak-ng');
  }
  await run('espeak-ng', ['-v', lang, '-s', '150', '-w', out, text]);
  return 'espeak-ng';
}

export async function sayIntoMic(vm: string, text: string, opts: { lang?: string }) {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-vm-'));
  try {
    const wav = join(tmp, 'speech.wav');
    const engine = await synthesize(text, wav, opts);
    log(`Speaking with ${engine}`);
    await playIntoMic(vm, wav);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function recordSpeaker(vm: string, out: string, seconds: number) {
  await ensureSinks(vm);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('parecord', [
      '-d',
      `${speakerSinkName(vm)}.monitor`,
      '--file-format=wav',
      '--rate=48000',
      '--channels=1',
      out,
    ]);
    child.on('error', reject);
    child.on('close', () => {
      resolve();
    });
    setTimeout(() => child.kill('SIGINT'), seconds * 1000);
  });
}

export interface Level {
  durationSec: number;
  rms: number;
  peak: number;
  rmsDbfs: number;
  silent: boolean;
}

// Reads 16-bit PCM WAV (what parecord, espeak-ng, piper and ffmpeg -c:a pcm_s16le produce).
export function wavLevel(buffer: Buffer): Level {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new UserError('Not a WAV file');
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    let size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new UserError(`Only 16-bit PCM WAV is supported (got ${bits}-bit)`);
      // Streaming writers leave the size as 0 or 0xFFFFFFFF until they finish.
      if (size === 0 || size === 0xffffffff || body + size > buffer.length) size = buffer.length - body;
      const samples = Math.floor(size / 2);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < samples; i++) {
        const v = buffer.readInt16LE(body + i * 2) / 32768;
        sumSquares += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
      const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      return {
        durationSec: sampleRate ? samples / channels / sampleRate : 0,
        rms,
        peak,
        rmsDbfs,
        silent: rmsDbfs < -50,
      };
    }
    offset = body + size + (size % 2);
  }
  throw new UserError('WAV file has no data chunk');
}

export function fileLevel(path: string): Level {
  return wavLevel(readFileSync(path));
}
