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
// The guest agent keeps no session: replies to earlier, abandoned requests can still be queued.
// guest-sync-delimited fixes that: the agent sends 0xFF and then a reply with our random id, and
// everything before that reply is stale.
export async function qga<T = unknown>(
  path: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!existsSync(path)) throw new Error('Guest agent socket missing; is the VM running?');
  const socket = connect(path);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const id = Math.floor(Math.random() * 1e9);
    let buffer = '';
    let synced = false;
    const reply = new Promise<QmpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`guest agent did not answer ${command}`));
      }, 30_000);
      socket.on('data', (chunk: Buffer) => {
        // 0xFF is the sync delimiter; it never occurs in UTF-8 JSON.
        buffer += Buffer.from(chunk.filter((b) => b !== 0xff)).toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          let parsed: QmpReply;
          try {
            parsed = JSON.parse(line) as QmpReply;
          } catch {
            continue;
          }
          if (!synced) {
            if (parsed.return === id) {
              synced = true;
              socket.write(
                JSON.stringify(args ? { execute: command, arguments: args } : { execute: command }) + '\n',
              );
            }
            continue;
          }
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });
    socket.write(JSON.stringify({ execute: 'guest-sync-delimited', arguments: { id } }) + '\n');
    const result = await reply;
    if (result.error) throw new Error(`guest agent ${command}: ${result.error.desc}`);
    return result.return as T;
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
