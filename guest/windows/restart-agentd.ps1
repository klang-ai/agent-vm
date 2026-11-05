# Restarts agentd in the desktop session, e.g. after a new token or a new agentd.mjs.
# Stop-ScheduledTask only ends the task's conhost.exe, not the node.exe it started, so the old
# agentd would keep the port (and the old token). End node first.
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*agentd.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Stop-ScheduledTask -TaskName 'agent-vm-agentd' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'agent-vm-agentd'
