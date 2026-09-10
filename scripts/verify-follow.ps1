# Full-screen follow check.
#
# Drives the simulated cursor to both far edges of the work area and waits for
# the pet to arrive. This is the regression guard for "follow only works in some
# places", which happened because the renderer could only see the cursor while it
# was inside the pet's own window.
#
# Takes ~35 s (the pet walks 230 px/s and the screen is 2560 px wide), so it is
# kept out of scripts/verify-behaviour.ps1.
#
#   powershell -File scripts/verify-follow.ps1
#   powershell -File scripts/verify-follow.ps1 -Exe dist\portable\CalicoPet-portable-0.1.0.exe
#
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).

param(
  [string]$Exe = '',
  [string]$LogDir = 'dist\smoke'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logDirFull = (Resolve-Path $LogDir).Path

$log = Join-Path $logDirFull 'follow.log'
Remove-Item $log -Force -ErrorAction SilentlyContinue
$env:PET_LOG = $log
# three diagonal legs of up to ~2300px at 230px/s each, plus settling
$env:PET_SMOKE_MS = '90000'
$env:PET_TEST_PROBE = 'follow'
$env:PET_TEST_CONFIG = '{"mode":"follow","scale":3}'

$userData = Join-Path $logDirFull 'userdata-follow'
Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $userData | Out-Null

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if ($Exe) {
  if (-not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }
  $proc = Start-Process -FilePath $Exe -ArgumentList @('--user-data-dir', $userData) -PassThru
} else {
  if (-not (Test-Path $electron)) { throw "electron runtime missing: $electron" }
  $proc = Start-Process -FilePath $electron -ArgumentList @('.', '--user-data-dir', $userData) `
    -PassThru -NoNewWindow -WorkingDirectory $root
}

Write-Host 'driving the cursor to three points (this takes up to ~70s)...'
$proc.WaitForExit(180000) | Out-Null
if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }

$text = if (Test-Path $log) { Get-Content $log -Raw -Encoding UTF8 } else { '' }
$m = [regex]::Match($text, '"followCheck":(\{.*?"ok":(?:true|false))')
if (-not $m.Success) {
  Write-Host 'FAIL: no followCheck result in the log'
  Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 4
  exit 1
}

Write-Host ''
Write-Host "result: $($m.Groups[1].Value)"
$ok = $m.Groups[1].Value -match '"ok":true'
Write-Host ''
if ($ok) {
  Write-Host 'PASS: the pet tracked the cursor to both edges of the work area.'
  exit 0
}
Write-Host 'FAIL: the pet did not reach one of the targets.'
exit 1
