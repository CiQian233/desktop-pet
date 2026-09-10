# Package the app into a portable exe and/or an NSIS installer.
#
#   powershell -File scripts/pack.ps1                 # both
#   powershell -File scripts/pack.ps1 -Target portable
#   powershell -File scripts/pack.ps1 -Target installer
#
# Why this wrapper exists instead of calling electron-builder directly:
# electron-builder extracts the winCodeSign helper with `7za x`, and that archive
# contains two macOS symlinks Windows cannot create without elevation. 7za then
# exits 2 and the build fails, even though the only file actually needed
# (rcedit-x64.exe) extracted fine. scripts/build-7za-shim.ps1 temporarily
# replaces 7za.exe with a shim that strips those entries first; this script
# installs it, packs, and always restores the genuine binary.
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

$shimScript = Join-Path $PSScriptRoot 'build-7za-shim.ps1'

$targets = switch ($Target) {
  'portable' { @('portable') }
  'installer' { @('nsis') }
  default { @('portable', 'nsis') }
}

try {
  Write-Host 'installing 7za shim...'
  & $shimScript

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
        & npx electron-builder --win $t --config electron-builder.config.cjs "--config.directories.output=$outDir"
        if ($LASTEXITCODE -ne 0) { $buildCode = $LASTEXITCODE; break }
      }
    }
  } finally {
    $ErrorActionPreference = $previous
  }

  if ($buildCode -ne 0) { throw "packaging failed (exit $buildCode)" }
} finally {
  Write-Host ''
  Write-Host 'restoring genuine 7za.exe...'
  & $shimScript -Restore
}

Write-Host ''
Write-Host 'artifacts:'
Get-ChildItem dist\portable, dist\installer -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.exe', '.blockmap' } |
  ForEach-Object { "  {0,-52} {1,8:N1} MB" -f $_.FullName.Replace("$root\", ''), ($_.Length / 1MB) }

Write-Host ''
Write-Host 'signature status:'
Get-ChildItem dist\portable, dist\installer -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.exe' } |
  ForEach-Object {
    $status = (Get-AuthenticodeSignature $_.FullName).Status
    $note = if ($status -eq 'NotSigned') { '  <- users will see "Unknown publisher"' } else { '' }
    "  {0,-52} {1}{2}" -f $_.Name, $status, $note
  }
