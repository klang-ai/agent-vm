# Runs once at the first logon (FirstLogonCommands, elevated). Its only job is to make the
# machine reachable over SSH with the host's key; everything else happens in bootstrap.ps1,
# which the host runs over SSH where failures are visible.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force C:\agent-vm | Out-Null
Start-Transcript -Path C:\agent-vm\firstboot.log -Append | Out-Null

# A test machine must never sleep, lock or reboot on its own.
powercfg /hibernate off
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization' /v NoLockScreen /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' /v NoAutoUpdate /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKCU\Control Panel\Desktop' /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null
Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private

# VirtIO guest tools (drivers + QEMU guest agent) from the virtio-win CD.
$virtio = Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path "$($_.Root)virtio-win-gt-x64.msi" } | Select-Object -First 1
if ($virtio) {
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($virtio.Root)virtio-win-gt-x64.msi`" /qn /norestart"
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($virtio.Root)guest-agent\qemu-ga-x86_64.msi`" /qn /norestart"
}

$msi = Get-ChildItem "$here\OpenSSH-Win64*.msi" | Select-Object -First 1
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart"
# sshd keeps its default shell (cmd.exe). agent-vm starts powershell itself; with PowerShell as
# the default shell, exit codes and stderr would pass through two PowerShells and get mangled.

# Members of Administrators only read administrators_authorized_keys, and sshd ignores it
# unless SYSTEM and Administrators are the only principals with access.
New-Item -ItemType Directory -Force C:\ProgramData\ssh | Out-Null
Copy-Item "$here\authorized_keys" C:\ProgramData\ssh\administrators_authorized_keys -Force
icacls.exe C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null

if (-not (Get-NetFirewallRule -Name agent-vm-sshd -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name agent-vm-sshd -DisplayName 'agent-vm sshd' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}
Set-Service sshd -StartupType Automatic
Restart-Service sshd
# sshd writes its default config on first start; from then on only the host's key gets in.
$config = 'C:\ProgramData\ssh\sshd_config'
(Get-Content $config) -replace '^#?\s*PasswordAuthentication\s+\w+', 'PasswordAuthentication no' | Set-Content $config -Encoding ascii
Restart-Service sshd

Set-Content C:\agent-vm\firstboot.done (Get-Date -Format o)
Stop-Transcript | Out-Null
