# Boot the app for a few seconds, capture its log, and report what the renderer
# managed to load. Used to verify a build (and the packaged exe) without a human
# looking at the screen.
#
#   powershell -File scripts/smoke.ps1                     # dev build
#   powershell -File scripts/smoke.ps1 -Exe path\to.exe    # packaged exe
#
# NOTE: kept ASCII-only on purpose -- Windows PowerShell 5.1 reads .ps1 files as
# ANSI, which corrupts non-ASCII string literals.

param(
  [string]$Exe = '',
  [int]$Seconds = 5,
  [string]$LogDir = 'dist\smoke'
)

$ErrorActionPreference = 'Stop'
# The host tooling may launch this script with Electron forced into Node mode
# (ELECTRON_RUN_AS_NODE=1) and with an injected NODE_OPTIONS preload. Both make
# electron.exe exit before app.whenReady; the app test must start a real runtime.
$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path (Resolve-Path $LogDir) 'boot.log'
Remove-Item $log -Force -ErrorAction SilentlyContinue
$userData = Join-Path (Resolve-Path $LogDir) 'userdata-smoke'
Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $userData | Out-Null

$env:PET_LOG = $log
$env:PET_SMOKE_MS = "$($Seconds * 1000)"
# Keep the test away from the user's real config, and make the single-instance
# lock independent from a running copy of the pet.
$env:PET_USER_DATA_DIR = $userData

if ($Exe) {
  if (-not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }
  $proc = Start-Process -FilePath $Exe -PassThru
} else {
  $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { throw "electron runtime missing: $electron" }
  $proc = Start-Process -FilePath $electron -ArgumentList '.' -PassThru -WorkingDirectory $root
}

Write-Host "started pid $($proc.Id), waiting up to $Seconds s..."
$exited = $proc.WaitForExit(($Seconds + 15) * 1000)
if (-not $exited) {
  Write-Host 'process did not exit on its own; killing.'
  try { $proc.Kill() } catch { }
}

Write-Host ''
Write-Host '--- boot log ---'
# the log carries UTF-8 Chinese from the renderer; Windows PowerShell 5.1 would
# otherwise decode it as ANSI and mangle every match below
if (Test-Path $log) { Get-Content $log -Encoding UTF8 } else { Write-Host '(no log produced)' }

Write-Host ''
Write-Host '--- verdict ---'
if (-not (Test-Path $log)) {
  Write-Host 'FAIL: no log output'
  Write-Host '  A missing log means the app never wrote a single line, i.e. it likely never'
  Write-Host '  really started -- distinguish this from a crash AFTER startup:'
  Write-Host '    * single-instance lock: another CalicoPet / electron already running?'
  Write-Host '    * permission block: "Lock file can not be created" / error 0x5 in a console run'
  Write-Host '    * restricted sandbox session: Electron cannot start at all there'
  Write-Host '    * dev build: is dist/ built (npm run build)?  packaged: does the exe exist?'
  Write-Host '  See docs/PROJECT_LOG.md section 4l for the known cases.'
  exit 1
}
$text = Get-Content $log -Raw -Encoding UTF8
$bad = @('renderer gone', 'render-process-gone', 'fatal', 'Failed to load', 'ERR_', 'never became ready')
# literal substring checks: -like would treat the '[' in '[smoke]' as a wildcard
$hit = @($bad | Where-Object { $text.Contains($_) })
if ($hit.Count -gt 0) { Write-Host "FAIL: log contains $($hit -join ', ')"; exit 1 }
if (-not $text.Contains('[smoke] renderer ready')) { Write-Host 'FAIL: renderer never reported ready'; exit 1 }

# parse the diagnostics JSON the renderer published
$m = [regex]::Match($text, '\[smoke\] renderer ready: (\{.*\})')
if (-not $m.Success) { Write-Host 'FAIL: no diagnostics payload'; exit 1 }
$diag = $m.Groups[1].Value | ConvertFrom-Json
Write-Host ("  anims={0} sprites={1} native={2}x{3} scale={4} canvas={5}x{6} mode={7} ground={8}" -f `
    $diag.anims.Count, $diag.sprites, $diag.css.w, $diag.css.h, $diag.scale, `
    $diag.canvas.w, $diag.canvas.h, $diag.mode, $diag.pos.ground)

# expected native sprite size (assets/sprites/chibi-hd/meta.json)
$NATIVE_W = 76
$NATIVE_H = 68
$DEFAULT_SCALE = 3

if ($diag.sprites -lt 7) { Write-Host "FAIL: expected 7 animations, got $($diag.sprites)"; exit 1 }
if ($diag.canvas.w -le 0 -or $diag.canvas.h -le 0) { Write-Host 'FAIL: canvas has no backing size'; exit 1 }
$wantW = $NATIVE_W * $DEFAULT_SCALE
$wantH = $NATIVE_H * $DEFAULT_SCALE
if ($diag.css.w -ne $wantW -or $diag.css.h -ne $wantH) {
  Write-Host "FAIL: default ${DEFAULT_SCALE}x should render ${wantW}x${wantH}, got $($diag.css.w)x$($diag.css.h)"; exit 1
}
if (-not $diag.pos.ground) { Write-Host 'FAIL: pet is not resting on the ground line'; exit 1 }
Write-Host "PASS: app booted, 7 animations loaded, ${DEFAULT_SCALE}x default, pet grounded."
exit 0
