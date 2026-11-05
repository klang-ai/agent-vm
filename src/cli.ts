#!/usr/bin/env node
import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileLevel, playIntoMic, recordSpeaker, sayIntoMic } from './audio.js';
import { doctor } from './doctor.js';
import { desktopExec, pull, push, sshExec, sshShell } from './guest.js';
import { click, parseCombo, pressKeys, screenSize, screenshot, typeText } from './input.js';
import { isRunning } from './qemu.js';
import { withQmp } from './qmp.js';
import { listVms, loadVm, resolveVmName, vmPaths, type VmConfig } from './state.js';
import { psQuote, UserError, which } from './util.js';
import * as vms from './vm.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const program = new Command()
  .name('agent-vm')
  .description('Let AI agents drive a real Windows desktop in a local VM.')
  .version(pkg.version)
  .option('--vm <name>', 'VM to act on (default: $AGENT_VM, or the only VM)')
  .option('--json', 'machine-readable output')
  .showHelpAfterError();

const opts = () => program.opts<{ vm?: string; json?: boolean }>();
const currentVm = (): VmConfig => loadVm(resolveVmName(opts().vm));

function runningVm(): VmConfig {
  const vm = currentVm();
  if (!isRunning(vm)) throw new UserError(`${vm.name} is not running`, `Start it with: agent-vm up`);
  return vm;
}

function print(value: unknown, human?: string) {
  if (opts().json || human === undefined) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

function emit(result: { code: number; stdout: string; stderr: string }) {
  if (opts().json) print(result);
  else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.code;
}

interface CreateFlags {
  cpus: number;
  memory: number;
  disk: number;
  resolution: string;
  iso?: string;
  productKey?: string;
  locale: string;
  timeZone: string;
  tpm: boolean;
}

const psArgs = (args: string[]) => (args.length ? `@(${args.map(psQuote).join(',')})` : '@()');

program
  .command('create')
  .description('Download Windows 11, install it unattended and bootstrap the agent tooling')
  .argument('[name]', 'VM name', 'win11')
  .option('--cpus <n>', 'virtual CPUs', (v) => Number(v), 4)
  .option('--memory <gb>', 'memory in GB', (v) => Number(v), 8)
  .option('--disk <gb>', 'disk size in GB', (v) => Number(v), 80)
  .option('--resolution <WxH>', 'screen resolution', '1920x1080')
  .option('--iso <path>', 'Windows ISO to install (default: Windows 11 Enterprise Evaluation)')
  .option('--product-key <key>', 'product key, needed for multi-edition retail ISOs')
  .option('--locale <locale>', 'Windows display language and locale', 'en-US')
  .option('--time-zone <tz>', 'Windows time zone id', 'UTC')
  .option('--tpm', 'attach a software TPM 2.0 (swtpm)', false)
  .action(async (name: string, o: CreateFlags) => {
    const vm = await vms.create({
      name,
      cpus: o.cpus,
      memoryGb: o.memory,
      diskGb: o.disk,
      resolution: o.resolution,
      iso: o.iso,
      productKey: o.productKey,
      locale: o.locale,
      timeZone: o.timeZone,
      tpm: o.tpm,
    });
    print(await vms.status(vm), `${vm.name} created`);
  });

program
  .command('install')
  .description('Resume an interrupted create (re-runs setup on the existing disk)')
  .action(async () => vms.install(currentVm()));

program
  .command('bootstrap')
  .description('Re-run guest bootstrap (Node, agent-desktop, agentd, ffmpeg)')
  .action(async () => vms.bootstrap(runningVm()));

program
  .command('up')
  .description('Start the VM and wait until the desktop is ready')
  .option('-c, --checkpoint <name>', 'restore this checkpoint first')
  .action(async (o: { checkpoint?: string }) => {
    const vm = currentVm();
    await vms.up(vm, o);
    print(await vms.status(vm), `${vm.name} is up`);
  });

program
  .command('down')
  .description('Shut the VM down (ACPI), or stop it immediately with --force')
  .option('-f, --force', 'stop QEMU without a guest shutdown')
  .action(async (o: { force?: boolean }) => vms.down(currentVm(), o));

program
  .command('status')
  .description('Show VM state, reachability and ports')
  .action(async () => {
    const s = await vms.status(currentVm());
    print(
      s,
      [
        `${s.name}: ${s.running ? 'running' : 'stopped'}${s.installed ? '' : ' (not installed)'}`,
        `  ssh: ${s.ssh ? 'ok' : '-'}   desktop agent: ${s.desktop ? 'ok' : '-'}`,
        `  viewer: ${s.spice}`,
        `  checkpoints: ${s.checkpoints.join(', ') || '-'}`,
      ].join('\n'),
    );
  });

program
  .command('list')
  .description('List VMs')
  .action(() => {
    const rows = listVms().map((name) => ({ name, running: isRunning(loadVm(name)) }));
    print(rows, rows.map((r) => `${r.name}\t${r.running ? 'running' : 'stopped'}`).join('\n') || 'No VMs');
  });

program
  .command('destroy')
  .description('Stop the VM and delete its disk, checkpoints and audio devices')
  .argument('<name>', 'VM name (required, to avoid accidents)')
  .action(async (name: string) => vms.destroy(loadVm(name)));

program
  .command('view')
  .description('Open a SPICE viewer on the VM screen (for humans)')
  .action(() => {
    const vm = runningVm();
    const viewer = ['remote-viewer', 'spicy'].find((v) => which(v));
    if (!viewer) {
      throw new UserError('No SPICE viewer found', 'Install virt-viewer (remote-viewer) or spice-client-gtk');
    }
    const args =
      viewer === 'spicy'
        ? ['--title', vm.name, '-h', '127.0.0.1', '-p', String(vm.ports.spice)]
        : ['--title', vm.name, `spice://127.0.0.1:${vm.ports.spice}`];
    spawn(viewer, args, { detached: true, stdio: 'ignore' }).unref();
  });

program
  .command('exec')
  .description('Run PowerShell in the guest (SSH session, elevated). Use --desktop for the user session')
  .argument('<script...>', 'PowerShell to run; join words or pass one quoted string')
  .option('-d, --desktop', "run in the signed-in user's desktop session (visible windows, UI Automation)")
  .option('--detach', 'with --desktop: start it and return immediately')
  .option('-t, --timeout <sec>', 'with --desktop: kill after this many seconds', (v) => Number(v), 120)
  .action(async (script: string[], o: { desktop?: boolean; detach?: boolean; timeout: number }) => {
    const vm = runningVm();
    const text = script.join(' ');
    if (o.desktop) emit(await desktopExec(vm, text, { detach: o.detach, timeoutMs: o.timeout * 1000 }));
    else emit(await sshExec(vm, text));
  });

program
  .command('ssh')
  .description('Interactive PowerShell over SSH')
  .action(async () => {
    process.exitCode = await sshShell(runningVm());
  });

program
  .command('push')
  .description('Copy a file or directory into the guest')
  .argument('<local>')
  .argument('<remote>', 'e.g. C:/Users/agent/Desktop/')
  .action(async (local: string, remote: string) => push(runningVm(), local, remote));

program
  .command('pull')
  .description('Copy a file or directory out of the guest')
  .argument('<remote>')
  .argument('<local>')
  .action(async (remote: string, local: string) => pull(runningVm(), remote, local));

program
  .command('install-app')
  .description('Copy an installer (.exe/.msi) into the guest and run it silently as the desktop user')
  .argument('<installer>')
  .option('--args <args>', 'installer arguments (default: /S for .exe, /qn for .msi)')
  .action(async (installer: string, o: { args?: string }) => {
    const vm = runningVm();
    const name = basename(installer);
    const remote = `C:/agent-vm/installers/${name}`;
    await sshExec(vm, `New-Item -ItemType Directory -Force C:/agent-vm/installers | Out-Null`);
    await push(vm, resolve(installer), remote);
    const isMsi = name.toLowerCase().endsWith('.msi');
    const args = o.args ?? (isMsi ? '/qn /norestart' : '/S');
    const script = isMsi
      ? `$p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList ${psQuote(`/i "${remote}" ${args}`)}; exit $p.ExitCode`
      : `$p = Start-Process ${psQuote(remote)} -Wait -PassThru -ArgumentList ${psQuote(args)}; exit $p.ExitCode`;
    emit(await desktopExec(vm, script, { timeoutMs: 600_000 }));
  });

program
  .command('launch')
  .description('Start a program in the desktop session')
  .argument('<program>', 'path or name of the executable')
  .argument('[args...]')
  .option('--cdp [port]', 'expose WebView2/Chromium DevTools on this guest port (for `agent-vm web`)')
  .option('-e, --env <KEY=VALUE...>', 'extra environment variables')
  .action(async (exe: string, args: string[], o: { cdp?: string | boolean; env?: string[] }) => {
    const vm = runningVm();
    const env: Record<string, string> = {};
    for (const pair of o.env ?? []) {
      const i = pair.indexOf('=');
      if (i < 1) throw new UserError(`Bad --env '${pair}'`, 'Use KEY=VALUE');
      env[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if (o.cdp) {
      const port = o.cdp === true ? 9222 : Number(o.cdp);
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    }
    const script = `$p = Start-Process ${psQuote(exe)} -PassThru${args.length ? ` -ArgumentList ${psArgs(args)}` : ''}; $p.Id`;
    const result = await desktopExec(vm, script, { env });
    if (result.code !== 0) {
      emit(result);
      return;
    }
    const pid = Number(result.stdout.trim());
    print({ pid }, `started pid ${pid}`);
  });

program
  .command('ui')
  .description(
    'Run agent-desktop (Windows UI Automation) in the desktop session: snapshot -i, click @e3, ...',
  )
  .argument('<args...>', 'agent-desktop arguments; see `agent-vm ui --help-tool`')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (args: string[]) => {
    const vm = runningVm();
    const result = await desktopExec(
      vm,
      `& 'C:\\agent-vm\\npm\\agent-desktop.cmd' ${psArgs(args)}; exit $LASTEXITCODE`,
      {
        timeoutMs: 180_000,
      },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  });

program
  .command('web')
  .description('Run agent-browser against DevTools in the guest (start the app with `launch --cdp`)')
  .argument('<args...>', 'agent-browser arguments, e.g. snapshot -i')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (args: string[]) => {
    const vm = runningVm();
    const { ensureMaster } = await import('./guest.js');
    await ensureMaster(vm);
    if (!which('agent-browser')) throw new UserError('agent-browser not found', 'npm i -g agent-browser');
    const child = spawn('agent-browser', ['--cdp', String(vm.ports.cdp), ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise<number>((r) =>
      child.on('close', (code) => {
        r(code ?? 1);
      }),
    );
  });

program
  .command('screenshot')
  .description('Capture the whole screen from the host (works even if the guest is wedged)')
  .argument('[file]', 'output PNG', 'screenshot.png')
  .action(async (file: string) => {
    const vm = runningVm();
    const out = resolve(file);
    const size = await withQmp(vmPaths(vm.name).qmp, (q) => screenshot(q, out));
    print({ file: out, ...size }, out);
  });

program
  .command('key')
  .description('Press a key combo from the host, e.g. ctrl+alt+delete, win+r, enter')
  .argument('<combo...>')
  .action(async (combos: string[]) => {
    const vm = runningVm();
    await withQmp(vmPaths(vm.name).qmp, async (q) => {
      for (const combo of combos) await pressKeys(q, parseCombo(combo));
    });
  });

program
  .command('type')
  .description('Type ASCII text from the host keyboard (US layout)')
  .argument('<text>')
  .action(async (text: string) => {
    const vm = runningVm();
    await withQmp(vmPaths(vm.name).qmp, (q) => typeText(q, text));
  });

program
  .command('click')
  .description('Click at screen pixel coordinates from the host')
  .argument('<x>', 'x pixel', Number)
  .argument('<y>', 'y pixel', Number)
  .addOption(new Option('--button <button>').choices(['left', 'right', 'middle']).default('left'))
  .option('--double', 'double click')
  .action(async (x: number, y: number, o: { button: string; double?: boolean }) => {
    const vm = runningVm();
    const p = vmPaths(vm.name);
    await withQmp(p.qmp, async (q) => click(q, x, y, await screenSize(q, p.dir), o));
  });

const checkpoint = program
  .command('checkpoint')
  .description('Save and restore full VM state (memory + disk)');
checkpoint
  .command('save')
  .argument('<name>')
  .action(async (name: string) => {
    const vm = runningVm();
    await vms.checkpointSave(vm, name);
    await vms.waitForReady(vm);
  });
checkpoint
  .command('restore')
  .argument('<name>')
  .action(async (name: string) => {
    const vm = currentVm();
    const started = Date.now();
    await vms.up(vm, { checkpoint: name });
    print({ restored: name, seconds: (Date.now() - started) / 1000 }, `restored '${name}'`);
  });
checkpoint.command('list').action(async () => {
  const list = await vms.checkpointList(currentVm());
  print(list, list.map((c) => `${c.name}\t${c.vmStateSize}\t${c.date}`).join('\n') || 'No checkpoints');
});
checkpoint
  .command('delete')
  .argument('<name>')
  .action(async (name: string) => vms.checkpointDelete(currentVm(), name));

const mic = program.command('mic').description("Feed audio into the guest's microphone");
mic
  .command('play')
  .description('Play an audio file into the microphone (wav/flac/ogg; others need ffmpeg)')
  .argument('<file>')
  .action(async (file: string) => playIntoMic(currentVm().name, resolve(file)));
mic
  .command('say')
  .description('Speak text into the microphone (piper if installed, else espeak-ng)')
  .argument('<text...>')
  .option('-l, --lang <lang>', 'language: en, sv, da, no, de', 'en')
  .action(async (text: string[], o: { lang: string }) => sayIntoMic(currentVm().name, text.join(' '), o));

program
  .command('speaker')
  .description('Record what the guest plays on its speakers')
  .argument('<file>', 'output WAV')
  .option('-s, --seconds <n>', 'duration', (v) => Number(v), 5)
  .action(async (file: string, o: { seconds: number }) => {
    await recordSpeaker(currentVm().name, resolve(file), o.seconds);
    const level = fileLevel(resolve(file));
    print(
      level,
      `${file}: ${level.durationSec.toFixed(1)}s, ${level.rmsDbfs.toFixed(1)} dBFS${level.silent ? ' (silent)' : ''}`,
    );
  });

program
  .command('level')
  .description('Loudness of a 16-bit WAV file, to assert that audio was (not) captured')
  .argument('<file>')
  .action((file: string) => {
    const level = fileLevel(resolve(file));
    print(
      level,
      `${level.durationSec.toFixed(1)}s, ${level.rmsDbfs.toFixed(1)} dBFS${level.silent ? ' (silent)' : ''}`,
    );
    if (level.silent) process.exitCode = 3;
  });

program
  .command('hosts')
  .description('Point host names at the host machine from inside the guest (e.g. local dev servers)')
  .argument('<names...>')
  .action(async (names: string[]) => {
    const vm = runningVm();
    const script = `
$path = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"
$lines = Get-Content $path | Where-Object { $_ -notmatch '# agent-vm$' }
$names = ${psArgs(names)}
$lines += $names | ForEach-Object { "10.0.2.2\`t$_\`t# agent-vm" }
Set-Content -Path $path -Value $lines -Encoding ascii
ipconfig /flushdns | Out-Null`;
    emit(await sshExec(vm, script));
  });

program
  .command('trust-ca')
  .description("Add a root CA certificate (PEM) to the guest's trusted roots, e.g. mkcert's")
  .argument('<pem>')
  .action(async (pem: string) => {
    const vm = runningVm();
    await push(vm, resolve(pem), 'C:/agent-vm/ca.pem');
    emit(
      await sshExec(
        vm,
        `Import-Certificate -FilePath C:/agent-vm/ca.pem -CertStoreLocation Cert:/LocalMachine/Root | Out-Null`,
      ),
    );
  });

program
  .command('doctor')
  .description('Check host requirements and VM health')
  .action(async () => {
    const checks = await doctor(opts().vm);
    print(
      checks,
      checks
        .map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
        .join('\n'),
    );
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof UserError) {
    process.stderr.write(`agent-vm: ${error.message}\n${error.hint ? `  ${error.hint}\n` : ''}`);
  } else {
    process.stderr.write(
      `agent-vm: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
