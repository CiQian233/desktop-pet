# Install (or restore) the 7za.exe shim used while packaging.
#
#   powershell -File scripts/build-7za-shim.ps1            # install shim
#   powershell -File scripts/build-7za-shim.ps1 -Restore   # put the real 7za back
#
# Rationale is documented in scripts/seven-zip-shim.cs and scripts/pack.ps1.
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).

param([switch]$Restore)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'node_modules\7zip-bin\win\x64'
$shim = Join-Path $dir '7za.exe'
$real = Join-Path $dir '7za-real.exe'
$cs = Join-Path $PSScriptRoot 'seven-zip-shim.cs'

if (-not (Test-Path $dir)) { throw "7zip-bin directory missing: $dir" }

if ($Restore) {
  if (-not (Test-Path $real)) { throw "nothing to restore: $real missing" }
  if (Test-Path $shim) { Remove-Item $shim -Force }
  Move-Item $real $shim -Force
  Write-Host "restored genuine 7za.exe ($((Get-Item $shim).Length) bytes)"
  exit 0
}

# keep exactly one copy of the genuine binary
if (-not (Test-Path $real)) {
  Copy-Item $shim $real -Force
  Write-Host "saved genuine binary as 7za-real.exe"
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
if (-not (Test-Path $cs)) { throw "shim source not found: $cs" }

& $csc /nologo /target:exe /optimize+ "/out:$shim" $cs
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }

Write-Host "7za shim installed: $shim ($((Get-Item $shim).Length) bytes)"
