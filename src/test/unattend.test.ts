import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unattendXml, type UnattendOptions } from '../windows/unattend.js';

const base: UnattendOptions = {
  computerName: 'win11',
  user: 'agent',
  password: 'agent-vm',
  locale: 'en-US',
  timeZone: 'UTC',
  driverPaths: ['viostor/w11/amd64', 'NetKVM/w11/amd64'],
};

// Enough of an XML check to catch broken templates without a parser dependency.
function assertBalanced(xml: string) {
  const stack: string[] = [];
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `unexpected </${name}>`);
    else stack.push(name!);
  }
  assert.deepEqual(stack, []);
}

describe('unattendXml', () => {
  it('is well formed', () => {
    assertBalanced(unattendXml(base));
  });

  it('escapes values', () => {
    const xml = unattendXml({ ...base, password: 'a<b&"c' });
    assert.ok(xml.includes('a&lt;b&amp;&quot;c'));
    assert.ok(!xml.includes('a<b&"c'));
    assertBalanced(xml);
  });

  it('only sets a product key when given one (evaluation media has none)', () => {
    assert.ok(!unattendXml(base).includes('<ProductKey>'));
    assert.ok(unattendXml({ ...base, productKey: 'AAAAA-BBBBB' }).includes('<Key>AAAAA-BBBBB</Key>'));
  });

  it('loads drivers from the virtio CD with Windows paths', () => {
    const xml = unattendXml(base);
    assert.ok(xml.includes('<Path>E:\\viostor\\w11\\amd64</Path>'));
    assert.ok(xml.includes('wcm:keyValue="2"'));
  });

  it('runs the first-boot script wherever its CD is mounted', () => {
    assert.match(unattendXml(base), /for %d in \(D E F G H I J\) do if exist %d:\\agent-vm\\firstboot\.ps1/);
  });

  it('logs the user in automatically', () => {
    assert.match(unattendXml(base), /<AutoLogon>[\s\S]*<Username>agent<\/Username>/);
  });
});
