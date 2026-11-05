// agent-vm guest daemon. Runs inside the interactive desktop session of the signed-in user
// (started by a logon scheduled task), because UI Automation, window focus and anything that
// should appear on screen do not work from an SSH session. The host reaches it through an
// SSH tunnel; it only listens on loopback and requires the token written at bootstrap.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.AGENT_VM_AGENTD_PORT ?? 7777);
const TOKEN = readFileSync('C:\\agent-vm\\agentd.token', 'utf8').trim();
const MAX_OUTPUT = 32 * 1024 * 1024;

const prelude =
  "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;";

function encode(script) {
  return Buffer.from(prelude + script, 'utf16le').toString('base64');
}

function exec({ script, timeoutMs = 120_000, detach = false, env = {} }) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encode(script),
  ];
  const options = { env: { ...process.env, ...env }, windowsHide: true };
  if (detach) {
    const child = spawn('powershell.exe', args, { ...options, detached: true, stdio: 'ignore' });
    child.unref();
    return Promise.resolve({ code: 0, stdout: '', stderr: '', pid: child.pid });
  }
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', args, options);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

const server = createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers['x-agent-vm-token'] !== TOKEN) return reply(401, { error: 'bad token' });
  if (req.method === 'GET' && req.url === '/health') {
    return reply(200, { ok: true, user: process.env.USERNAME, pid: process.pid, uptime: process.uptime() });
  }
  if (req.method === 'POST' && req.url === '/exec') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      return reply(200, await exec(JSON.parse(body)));
    } catch (e) {
      return reply(500, { error: String(e) });
    }
  }
  reply(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1');
