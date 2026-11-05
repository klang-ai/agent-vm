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
  it('round-trips through UTF-16LE base64, the script on its own line', () => {
    const script = "Write-Output 'café ✓'";
    const lines = Buffer.from(encodePowerShell(script), 'base64').toString('utf16le').split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /ProgressPreference='SilentlyContinue'.*\$env:Path=/);
    assert.equal(lines[1], script);
    assert.match(lines[2] ?? '', /^if \(-not \$\?\) \{ exit/);
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

describe('hasColour', () => {
  // A black 64x64 frame, optionally with one pixel set.
  const ppm = (pixel?: [number, number, number], at = 0) => {
    const body = Buffer.alloc(64 * 64 * 3, 0);
    if (pixel) {
      body.set(pixel, at * 3);
    }
    return Buffer.concat([Buffer.from('P6\n64 64\n255\n'), body]);
  };
  it('sees the blue Windows logo but not grey firmware text', async () => {
    const { hasColour } = await import('../vm.js');
    assert.equal(hasColour(ppm()), false);
    assert.equal(hasColour(ppm([200, 200, 200], 700)), false);
    assert.equal(hasColour(ppm([0, 120, 215], 700)), true);
    assert.equal(hasColour(Buffer.from('not a ppm')), false);
  });
});

describe('decodeClixml', () => {
  it('turns PowerShell CLIXML on stderr back into text', async () => {
    const { decodeClixml } = await import('../guest.js');
    const raw =
      'native-err\r\n#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">nosuchcmd : not recognized_x000D__x000A_</S><S S="Error">1&gt;&amp;2 : boom_x000D__x000A_</S>' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>';
    assert.equal(decodeClixml(raw), 'native-err\r\nnosuchcmd : not recognized\n1>&2 : boom\n');
    assert.equal(decodeClixml('plain error\n'), 'plain error\n');
  });
});
