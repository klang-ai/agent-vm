import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { encodePowerShell } from '../guest.js';
import { parseSnapshotTable } from '../vm.js';
import { freePort, psQuote, waitFor } from '../util.js';

describe('parseSnapshotTable', () => {
  it('parses HMP `info snapshots`', () => {
    const text = `List of snapshots present on all disks:
ID        TAG               VM SIZE                DATE     VM CLOCK     ICOUNT
--        clean            1.21 GiB 2026-11-05 19:40:01  00:12:31.004
--        signed-in         1.5 GiB 2026-11-05 20:01:11  00:20:00.100
`;
    assert.deepEqual(
      parseSnapshotTable(text).map((c) => c.name),
      ['clean', 'signed-in'],
    );
    assert.equal(parseSnapshotTable(text)[0]!.vmStateSize, '1.21 GiB');
  });

  it('parses `qemu-img snapshot -l`', () => {
    const text = `Snapshot list:
ID        TAG               VM SIZE                DATE        VM CLOCK     ICOUNT
1         clean            1.21 GiB 2026-11-05 19:40:01 0000:12:31.004          0
`;
    assert.deepEqual(parseSnapshotTable(text), [
      { name: 'clean', vmStateSize: '1.21 GiB', date: '2026-11-05 19:40:01' },
    ]);
  });

  it('returns nothing for "no snapshots"', () => {
    assert.deepEqual(parseSnapshotTable('There is no snapshot available.'), []);
  });
});

describe('encodePowerShell', () => {
  it('round-trips through UTF-16LE base64 with the prelude', () => {
    const script = "Write-Output 'hej på dig'";
    const decoded = Buffer.from(encodePowerShell(script), 'base64').toString('utf16le');
    assert.ok(decoded.endsWith(script));
    assert.ok(decoded.includes("ProgressPreference='SilentlyContinue'"));
  });
});

describe('psQuote', () => {
  it('doubles single quotes', () => {
    assert.equal(psQuote("it's"), "'it''s'");
  });
});

describe('freePort', () => {
  it('skips ports that are in use or reserved', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const busy = (server.address() as { port: number }).port;
    try {
      const port = await freePort(busy, new Set([busy + 1]));
      assert.ok(port > busy + 1);
    } finally {
      server.close();
    }
  });
});

describe('waitFor', () => {
  it('returns the first truthy value', async () => {
    let calls = 0;
    const value = await waitFor('thing', () => (++calls >= 3 ? 'done' : false), { intervalMs: 1 });
    assert.equal(value, 'done');
    assert.equal(calls, 3);
  });

  it('times out with the last error', async () => {
    await assert.rejects(
      waitFor(
        'thing',
        () => {
          throw new Error('nope');
        },
        { timeoutMs: 30, intervalMs: 5 },
      ),
      /waiting for thing \(last error: nope\)/,
    );
  });
});
