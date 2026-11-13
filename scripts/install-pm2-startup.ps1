$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildIndex = Join-Path $projectRoot "out\index.html"
if (-not (Test-Path $buildIndex)) {
  throw "Production build missing. Run npm run build before installing automatic startup."
}

$pm2Command = Get-Command pm2.cmd -ErrorAction SilentlyContinue
$pm2Path = if ($pm2Command) { $pm2Command.Source } else { $null }
if (-not $pm2Path) {
  $pm2Path = Join-Path $env:APPDATA "npm\pm2.cmd"
  if (-not (Test-Path $pm2Path)) { $pm2Path = $null }
}
if (-not $pm2Path) {
  throw "PM2 was not found. Install it with: npm install -g pm2"
}

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  throw "Port 3000 is already in use by PID $($listener.OwningProcess). Stop the current server and run this script again."
}

$taskName = "POS PM2 Autostart"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$startupScript = Join-Path $PSScriptRoot "pm2-start.ps1"
$powershell = Join-Path $PSHOME "powershell.exe"
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $startupScript
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Inicia o POS com PM2 quando este utilizador inicia sessão." `
  -Force | Out-Null

& $startupScript
if ($LASTEXITCODE -ne 0) {
  throw "The scheduled task was created, but the application did not start under PM2."
}

Write-Output "Automatic startup installed: task '$taskName' starts POS when you sign in."
