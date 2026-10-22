# Registers the K-Browser Control Server to start automatically with Windows.
# Run in an elevated PowerShell from the "server" folder:
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows-service.ps1
$ErrorActionPreference = 'Stop'
$serverDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe).Source
$dataDir = Join-Path $env:ProgramData 'KBrowserServer'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Push-Location $serverDir
npm ci --omit=dev
Pop-Location

# Only administrators and SYSTEM may read the data folder (it holds the vault key).
icacls $dataDir /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null

$cmd = "set KB_DATA_DIR=$dataDir&& `"$node`" `"$serverDir\src\index.js`" >> `"$dataDir\server.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd" -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'K-Browser Control Server' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

New-NetFirewallRule -DisplayName 'K-Browser Control Server (HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Domain,Private -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName 'K-Browser Discovery (UDP)' -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow -Profile Domain,Private -ErrorAction SilentlyContinue | Out-Null

Start-ScheduledTask -TaskName 'K-Browser Control Server'
Start-Sleep -Seconds 4
Write-Host "Server started. First admin password:"
Get-Content (Join-Path $dataDir 'initial-admin-password.txt') -ErrorAction SilentlyContinue
Write-Host "Open https://localhost:8443/admin/"
