# agent-vm — notes for coding agents

- `npm run check` must pass before every commit: strict type-checked eslint, prettier, tsc and the
  unit tests (`src/test`, node:test). CI also runs PSScriptAnalyzer on `guest/` and gitleaks.
- One runtime dependency (commander). Keep it that way unless there is a strong reason.
- Host tools are called as subprocesses (`qemu-*`, `ssh`, `pactl`, `pw-play`, `xorriso`, `curl`);
  QMP and the guest agent are spoken directly over unix sockets (`src/qmp.ts`).
- Every QEMU device must stay migratable, or checkpoints (`savevm`) break. See `src/qemu.ts`.
- Guest code lives in `guest/windows/`. `firstboot.ps1` only makes SSH work; everything else
  belongs in `bootstrap.ps1`, which must stay idempotent.
- Real-VM behaviour is not covered by CI. When changing qemu args, the unattend file or guest
  scripts, run `agent-vm create` on a fresh name and walk through the README quick start.
- Never commit anything from `~/.agent-vm` (keys, tokens, disks).
