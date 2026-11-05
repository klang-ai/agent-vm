# Run by `agent-vm create` over SSH (elevated) after first boot. The host has already copied
# the payload (Node MSI, ffmpeg, agentd, token) to C:\agent-vm\payload. Safe to re-run.
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$AgentDesktopVersion = 'latest'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payload = 'C:\agent-vm\payload'
$bin = 'C:\agent-vm\bin'
New-Item -ItemType Directory -Force $bin | Out-Null

function Step($name) { Write-Output "==> $name" }

# Windows PowerShell turns any stderr line of a native program into an error record, which
# $ErrorActionPreference = 'Stop' makes fatal (npm's warnings killed it mid-install). Run native
# tools with 'Continue' and judge them by exit code instead.
function Invoke-Native([scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "failed with exit code ${LASTEXITCODE}: $Command" }
}

function Add-MachinePath($dir) {
  $path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($path -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'Machine')
  }
  $env:Path = "$env:Path;$dir"
}

Step 'Visual C++ runtime'
if (-not (Test-Path "$env:SystemRoot\System32\vcruntime140.dll")) {
  $p = Start-Process "$payload\vc_redist.x64.exe" -Wait -PassThru -ArgumentList '/install', '/quiet', '/norestart'
  # 3010: installed, reboot recommended (not needed for new processes).
  if ($p.ExitCode -notin 0, 3010) { throw "vc_redist failed with exit code $($p.ExitCode)" }
}

Step 'Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $msi = Get-ChildItem "$payload\node-*.msi" | Select-Object -First 1
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart"
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
node --version

Step 'ffmpeg'
if (-not (Test-Path "$bin\ffmpeg.exe")) {
  $zip = Get-ChildItem "$payload\ffmpeg-*.zip" | Select-Object -First 1
  $tmp = Join-Path $env:TEMP 'ffmpeg-extract'
  Expand-Archive $zip.FullName -DestinationPath $tmp -Force
  Get-ChildItem $tmp -Recurse -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination $bin -Force
  Remove-Item $tmp -Recurse -Force
}
Add-MachinePath $bin

Step 'agent-desktop'
# A machine-wide prefix so the SSH session and the desktop session see the same install.
Invoke-Native { npm config set prefix 'C:\agent-vm\npm' --location=global } | Out-Null
Add-MachinePath 'C:\agent-vm\npm'
# Its postinstall downloads the native binary; npm 11 wants global install scripts allowed by name.
Invoke-Native { npm install -g "agent-desktop@$AgentDesktopVersion" --allow-scripts=agent-desktop --no-fund --no-audit } | Out-Null
Invoke-Native { & 'C:\agent-vm\npm\agent-desktop.cmd' version }

Step 'agentd (desktop-session daemon)'
Copy-Item "$payload\agentd.mjs" C:\agent-vm\agentd.mjs -Force
Copy-Item "$payload\agentd.token" C:\agent-vm\agentd.token -Force
Copy-Item "$payload\restart-agentd.ps1" C:\agent-vm\restart-agentd.ps1 -Force
icacls.exe C:\agent-vm\agentd.token /inheritance:r /grant "${User}:R" /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
$node = (Get-Command node).Source
# conhost --headless keeps the daemon from opening a console window on the desktop.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" C:\agent-vm\agentd.mjs" -WorkingDirectory C:\agent-vm
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'agent-vm-agentd' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
& C:\agent-vm\restart-agentd.ps1

Step 'Desktop settings for automation'
# Lets the app a test launches take the foreground, as it would when a person starts it. Without
# this, windows started from agentd open behind and UI Automation finds no focused window.
reg add 'HKCU\Control Panel\Desktop' /v ForegroundLockTimeout /t REG_DWORD /d 0 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Edge' /v HideFirstRunExperience /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\CloudContent' /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' /v ScoobeSystemSettingEnabled /t REG_DWORD /d 0 /f | Out-Null

Step 'SSH'
# Older agent-vm versions made PowerShell sshd's default shell, which mangles exit codes.
Remove-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -ErrorAction SilentlyContinue
# Key-only from here on.
$config = 'C:\ProgramData\ssh\sshd_config'
$current = Get-Content $config
$hardened = $current -replace '^#?\s*PasswordAuthentication\s+\w+', 'PasswordAuthentication no'
if (Compare-Object $current $hardened) {
  $hardened | Set-Content $config -Encoding ascii
  # Restarting sshd drops this very session, so do it from a detached process a moment later.
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 3; Restart-Service sshd'
}

Step 'Done'
