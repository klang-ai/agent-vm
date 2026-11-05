import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Qmp, qga } from '../qmp.js';

// A tiny fake of QEMU's QMP and guest-agent sockets.
function fakeQmp(path: string): Server {
  const server = createServer((socket) => {
    socket.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i)) as {
          execute: string;
          arguments?: Record<string, unknown>;
        };
        buffer = buffer.slice(i + 1);
        // Events can arrive at any time and must not be mistaken for replies.
        socket.write(JSON.stringify({ event: 'RTC_CHANGE', data: {} }) + '\n');
        if (msg.execute === 'boom') {
          socket.write(JSON.stringify({ error: { class: 'GenericError', desc: 'kaboom' } }) + '\n');
        } else if (msg.execute === 'human-monitor-command') {
          socket.write(
            JSON.stringify({ return: `ran ${String(msg.arguments?.['command-line'])}\r\n` }) + '\n',
          );
        } else socket.write(JSON.stringify({ return: { echo: msg.execute } }) + '\n');
      }
    });
  });
  server.listen(path);
  return server;
}

function fakeQga(path: string): Server {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i)) as { execute: string; arguments?: { id?: number } };
        buffer = buffer.slice(i + 1);
        if (msg.execute === 'guest-sync-delimited') {
          // Like the real agent: a stale reply left from an abandoned request, then the raw 0xFF
          // delimiter in its own chunk, then the sync reply.
          socket.write(JSON.stringify({ return: { stale: true } }) + '\n');
          socket.write(Buffer.from([0xff]));
          socket.write(JSON.stringify({ return: msg.arguments?.id }) + '\n');
        } else socket.write(JSON.stringify({ return: { ran: msg.execute } }) + '\n');
      }
    });
  });
  server.listen(path);
  return server;
}

describe('QMP client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-vm-test-'));
  let qmpServer: Server;
  let qgaServer: Server;

  before(async () => {
    qmpServer = fakeQmp(join(dir, 'qmp.sock'));
    qgaServer = fakeQga(join(dir, 'qga.sock'));
    await new Promise((r) => setTimeout(r, 20));
  });

  after(() => {
    qmpServer.close();
    qgaServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('negotiates and executes commands in order, skipping events', async () => {
    const qmp = await Qmp.open(join(dir, 'qmp.sock'));
    try {
      assert.deepEqual(await qmp.execute('query-status'), { echo: 'query-status' });
      assert.deepEqual(await qmp.execute('query-name'), { echo: 'query-name' });
      assert.equal(await qmp.hmp('savevm clean'), 'ran savevm clean');
    } finally {
      qmp.close();
    }
  });

  it('surfaces QMP errors', async () => {
    const qmp = await Qmp.open(join(dir, 'qmp.sock'));
    try {
      await assert.rejects(qmp.execute('boom'), /QMP boom: kaboom/);
    } finally {
      qmp.close();
    }
  });

  it('fails clearly when the VM is not running', async () => {
    await assert.rejects(Qmp.open(join(dir, 'missing.sock')), /is the VM running/);
  });

  it('talks to the guest agent after a sync', async () => {
    assert.deepEqual(await qga(join(dir, 'qga.sock'), 'guest-ping'), { ran: 'guest-ping' });
  });
});
