$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pm2Command = Get-Command pm2.cmd -ErrorAction SilentlyContinue
$pm2Path = if ($pm2Command) { $pm2Command.Source } else { $null }
if (-not $pm2Path) {
  $pm2Path = Join-Path $env:APPDATA "npm\pm2.cmd"
  if (-not (Test-Path $pm2Path)) { $pm2Path = $null }
}
if (-not $pm2Path) {
  throw "PM2 was not found. Install it with: npm install -g pm2"
}

Set-Location $projectRoot
& $pm2Path startOrRestart (Join-Path $projectRoot "ecosystem.config.cjs") --update-env
if ($LASTEXITCODE -ne 0) {
  throw "PM2 could not start the application."
}

& $pm2Path save
if ($LASTEXITCODE -ne 0) {
  throw "PM2 could not save the process list."
}
