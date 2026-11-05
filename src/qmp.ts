import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';

interface QmpReply {
  return?: unknown;
  error?: { class: string; desc: string };
  event?: string;
  QMP?: unknown;
}

export class Qmp {
  private buffer = '';
  private waiters: ((msg: QmpReply) => void)[] = [];
  private closed = false;

  private constructor(private socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as QmpReply;
        if (msg.event) continue;
        this.waiters.shift()?.(msg);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter({ error: { class: 'Closed', desc: 'QMP closed' } });
    });
  }

  static async open(path: string): Promise<Qmp> {
    if (!existsSync(path)) throw new Error('QMP socket missing; is the VM running?');
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const qmp = new Qmp(socket);
    await qmp.next();
    await qmp.execute('qmp_capabilities');
    return qmp;
  }

  private next(): Promise<QmpReply> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async execute<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error('QMP connection closed');
    const reply = this.next();
    this.socket.write(
      JSON.stringify(args ? { execute: command, arguments: args } : { execute: command }) + '\n',
    );
    const msg = await reply;
    if (msg.error) throw new Error(`QMP ${command}: ${msg.error.desc}`);
    return msg.return as T;
  }

  async hmp(commandLine: string): Promise<string> {
    const out = await this.execute<string>('human-monitor-command', { 'command-line': commandLine });
    return out.trim();
  }

  close() {
    this.socket.end();
  }
}

// The QEMU guest agent speaks the same JSON framing without a greeting. guest-sync first
// discards anything a previous, interrupted client left in the channel.
export async function qga<T = unknown>(
  path: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!existsSync(path)) throw new Error('Guest agent socket missing; is the VM running?');
  const socket = connect(path);
  socket.setEncoding('utf8');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const id = Math.floor(Math.random() * 1e9);
    let buffer = '';
    const replies: QmpReply[] = [];
    const wait = (count: number, timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`guest agent did not answer ${command}`));
        }, timeoutMs);
        const onData = (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/^\xff/, '').trim();
            buffer = buffer.slice(newline + 1);
            if (line) replies.push(JSON.parse(line) as QmpReply);
          }
          if (replies.length >= count) {
            clearTimeout(timer);
            socket.off('data', onData);
            resolve();
          }
        };
        socket.on('data', onData);
      });
    socket.write(JSON.stringify({ execute: 'guest-sync-delimited', arguments: { id } }) + '\n');
    await wait(1, 5000);
    socket.write(JSON.stringify(args ? { execute: command, arguments: args } : { execute: command }) + '\n');
    await wait(2, 30_000);
    const reply = replies[1]!;
    if (reply.error) throw new Error(`guest agent ${command}: ${reply.error.desc}`);
    return reply.return as T;
  } finally {
    socket.destroy();
  }
}

export async function withQmp<T>(path: string, fn: (qmp: Qmp) => Promise<T>): Promise<T> {
  const qmp = await Qmp.open(path);
  try {
    return await fn(qmp);
  } finally {
    qmp.close();
  }
}
