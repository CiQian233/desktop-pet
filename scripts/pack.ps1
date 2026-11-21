# Package the app into a portable exe and/or an NSIS installer.
#
#   powershell -File scripts/pack.ps1                 # both
#   powershell -File scripts/pack.ps1 -Target portable
#   powershell -File scripts/pack.ps1 -Target installer
#
# Why this wrapper exists instead of calling electron-builder directly:
# older electron-builder versions extract winCodeSign with `7za x`; that archive
# contains macOS symlinks Windows cannot create without elevation. The legacy
# 7za shim strips those entries and is restored after packaging. Electron-builder
# 26 no longer depends on 7zip-bin, so its native archive handling is used as-is.
#
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).

param(
  [ValidateSet('portable', 'installer', 'all')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# project-local caches so a build never needs the user profile
$env:ELECTRON_BUILDER_CACHE = Join-Path $root '.builder-cache'
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'

# electron-builder 26 starts npm.CMD through Windows PowerShell. Some pwsh-only
# terminals do not include its directory in PATH; add it for this process only.
$windowsPowerShellDir = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0'
if ((Test-Path (Join-Path $windowsPowerShellDir 'powershell.exe')) -and
    (($env:PATH -split ';') -notcontains $windowsPowerShellDir)) {
  $env:PATH = "$windowsPowerShellDir;$env:PATH"
}

$shimScript = Join-Path $PSScriptRoot 'build-7za-shim.ps1'
$shimDir = Join-Path $root 'node_modules\7zip-bin\win\x64'
$use7zaShim = Test-Path (Join-Path $shimDir '7za.exe')

$targets = switch ($Target) {
  'portable' { @('portable') }
  'installer' { @('nsis') }
  default { @('portable', 'nsis') }
}

try {
  if ($use7zaShim) {
    Write-Host 'installing legacy 7za shim...'
    & $shimScript
  } else {
    Write-Host '7zip-bin not present; using electron-builder native archive handling.'
  }

  Write-Host 'building app (assets + typecheck)...'
  # npm and electron-builder write progress/warnings to stderr, and with
  # $ErrorActionPreference='Stop' PowerShell would treat that as fatal, so relax
  # it for those calls and check exit codes explicitly.
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & npm run build
    $buildCode = $LASTEXITCODE

    if ($buildCode -eq 0) {
      foreach ($t in $targets) {
        $outDir = if ($t -eq 'portable') { 'dist/portable' } else { 'dist/installer' }
        Write-Host ''
        Write-Host "packaging $t -> $outDir"
        # --publish never: electron-builder detects CI (the CI env var) and then
        # tries to publish to GitHub Releases itself, which needs GH_TOKEN and
        # collides with the release step in .github/workflows/release.yml.
        # Building the artifacts is all this script should do.
        & npx electron-builder --win $t --publish never --config electron-builder.config.cjs "--config.directories.output=$outDir"
        if ($LASTEXITCODE -ne 0) { $buildCode = $LASTEXITCODE; break }
      }
    }
  } finally {
    $ErrorActionPreference = $previous
  }

  if ($buildCode -ne 0) { throw "packaging failed (exit $buildCode)" }
} finally {
  if ($use7zaShim) {
    Write-Host ''
    Write-Host 'restoring genuine 7za.exe...'
    & $shimScript -Restore
  }
}

Write-Host ''
Write-Host 'artifacts:'
Get-ChildItem dist\portable, dist\installer -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.exe', '.blockmap' } |
  ForEach-Object { "  {0,-52} {1,8:N1} MB" -f $_.FullName.Replace("$root\", ''), ($_.Length / 1MB) }

Write-Host ''
Write-Host 'signature status:'
# Reporting only. Get-AuthenticodeSignature comes from Microsoft.PowerShell.Security,
# which does not autoload in every host (it fails on GitHub's windows runner), so this
# must degrade quietly instead of failing a build whose artifacts are already produced.
if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
  Get-ChildItem dist\portable, dist\installer -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.exe' } |
    ForEach-Object {
      $status = (Get-AuthenticodeSignature $_.FullName).Status
      $note = if ($status -eq 'NotSigned') { '  <- users will see "Unknown publisher"' } else { '' }
      "  {0,-52} {1}{2}" -f $_.Name, $status, $note
    }
} else {
  Write-Host '  (Get-AuthenticodeSignature unavailable in this host -- skipped)'
}
