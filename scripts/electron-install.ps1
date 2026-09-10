# Download the Electron runtime that node_modules/electron expects.
#
# Needed because a plain `npm install` can fail here: the sandbox in some
# environments denies the spawned postinstall process (EPERM), and the user-level
# cache at %LOCALAPPDATA%\electron may not be writable. This script fetches into
# the project-local cache using the npmmirror binary mirror.
#
#   powershell -File scripts/electron-install.ps1
#
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$electronDir = Join-Path $root 'node_modules\electron'
if (-not (Test-Path $electronDir)) { throw 'node_modules\electron missing -- run: npm install' }

$env:electron_config_cache = Join-Path $root '.electron-cache'
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'

$version = (Get-Content (Join-Path $electronDir 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "electron package version: $version"

Push-Location $electronDir
try {
  & node install.js
  if ($LASTEXITCODE -ne 0) { throw "electron install.js failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

$exe = Join-Path $electronDir 'dist\electron.exe'
if (-not (Test-Path $exe)) { throw "runtime still missing: $exe" }
$actual = (& $exe --version) -join ''
Write-Host "runtime installed: $exe ($actual)"
