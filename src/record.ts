import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { micSinkName, speakerSinkName } from './audio.js';
import { withQmp } from './qmp.js';
import { run } from './util.js';

export interface RecordOptions {
  seconds: number;
  fps: number;
  // Which audio to put on the soundtrack: what the guest hears, what it plays, or nothing.
  audio: 'mic' | 'speaker' | 'none';
  width: number;
}

// Screendumps at the rate QEMU manages (a 1080p frame takes ~30-80 ms), each held on screen for
// as long as it really lasted, so the video plays back at real speed even when frames drop.
// QEMU serves one QMP client at a time, so each frame connects on its own; holding the connection
// for the whole recording would block every `key`, `click` and `type` until it ends.
export async function recordScreen(
  qmpPath: string,
  vm: string,
  out: string,
  opts: RecordOptions,
  stopped: () => boolean = () => false,
): Promise<{ frames: number; seconds: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-vm-record-'));
  const wav = join(dir, 'audio.raw');
  let audio: ChildProcess | undefined;
  let keepAlive: ChildProcess | undefined;
  try {
    if (opts.audio !== 'none') {
      const sink = opts.audio === 'mic' ? micSinkName(vm) : speakerSinkName(vm);
      // An idle null sink is suspended and its monitor goes quiet, which would squeeze the
      // soundtrack out of sync. Playing silence into it keeps it running.
      keepAlive = spawn('sh', [
        '-c',
        `exec pacat --playback --device=${sink} --format=s16le --rate=48000 --channels=1 < /dev/zero`,
      ]);
      audio = spawn('sh', [
        '-c',
        `exec parec --device=${sink}.monitor --format=s16le --rate=48000 --channels=1 > "${wav}"`,
      ]);
    }
    const start = Date.now();
    const times: number[] = [];
    const interval = 1000 / opts.fps;
    while (Date.now() - start < opts.seconds * 1000 && !stopped()) {
      const due = start + times.length * interval;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const t = Date.now();
      const filename = join(dir, frameName(times.length));
      await withQmp(qmpPath, (qmp) => qmp.execute('screendump', { filename, format: 'ppm' }));
      times.push(t - start);
    }
    const elapsed = (Date.now() - start) / 1000;
    audio?.kill('SIGTERM');
    keepAlive?.kill('SIGTERM');

    // ffmpeg's concat demuxer takes a duration per frame; the last one is listed twice so it shows.
    const list = times
      .map((t, i) => {
        const next = times[i + 1] ?? elapsed * 1000;
        return `file '${frameName(i)}'\nduration ${((next - t) / 1000).toFixed(3)}`;
      })
      .join('\n');
    writeFileSync(join(dir, 'frames.txt'), `${list}\nfile '${frameName(times.length - 1)}'\n`);

    const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')];
    if (audio) args.push('-f', 's16le', '-ar', '48000', '-ac', '1', '-i', wav);
    args.push(
      '-vf',
      `scale=${opts.width}:-2:flags=lanczos,format=yuv420p`,
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
    );
    // A null sink's monitor only delivers samples while something plays, so pad the audio and cut
    // both streams to the wall-clock length.
    if (audio) args.push('-af', 'apad', '-c:a', 'aac', '-b:a', '128k');
    args.push('-t', elapsed.toFixed(3));
    args.push(out);
    await run('ffmpeg', args);
    return { frames: times.length, seconds: elapsed };
  } finally {
    audio?.kill('SIGTERM');
    keepAlive?.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}

const frameName = (i: number) => `f${String(i).padStart(6, '0')}.ppm`;
