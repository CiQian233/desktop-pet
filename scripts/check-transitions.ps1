param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AuditArgs
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$python = if (Test-Path $venvPython) { $venvPython } else { 'python' }
& $python (Join-Path $root 'tools\check_transition_preservation.py') @AuditArgs
exit $LASTEXITCODE
