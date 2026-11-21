param([string]$Output = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }
$args = @((Join-Path $root 'tools\check_sprite_assets.py'))
if ($Output) { $args += @('--output', $Output) }
& $python @args
exit $LASTEXITCODE
