# Verify Windows' native hit region, not just the renderer's canvas hit test.
# The app uses an isolated config directory and no smoke timer, so it stays alive
# until this script closes only the process it started.
param([string]$LogDir = 'dist\smoke')

$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDirFull = Join-Path $root $LogDir
New-Item -ItemType Directory -Force -Path $logDirFull | Out-Null
$userData = Join-Path $logDirFull 'userdata-native-shape'
Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $userData | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NativeShapeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  public static IntPtr[] VisibleWindowsForPid(uint wanted) {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      RECT r; GetWindowRect(hwnd, out r);
      if (pid == wanted && IsWindowVisible(hwnd) && r.Right - r.Left > 50 && r.Bottom - r.Top > 50) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
"@

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$env:PET_USER_DATA_DIR = $userData
$env:PET_LOG = Join-Path $logDirFull 'native-shape.log'
Remove-Item Env:PET_SMOKE_MS -ErrorAction SilentlyContinue
Remove-Item Env:PET_TEST_PROBE -ErrorAction SilentlyContinue
Remove-Item Env:PET_TEST_CONFIG -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $electron -ArgumentList (@('.') + @('--user-data-dir', $userData)) -PassThru -WorkingDirectory $root

try {
  $pet = [IntPtr]::Zero
  for ($i = 0; $i -lt 60 -and $pet -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $handles = @([NativeShapeProbe]::VisibleWindowsForPid([uint32]$proc.Id))
    if ($handles.Count -gt 0) { $pet = $handles[0] }
  }
  if ($pet -eq [IntPtr]::Zero) { throw 'no visible native pet window found' }
  Start-Sleep -Milliseconds 500

  $rect = New-Object NativeShapeProbe+RECT
  if (-not [NativeShapeProbe]::GetWindowRect($pet, [ref]$rect)) { throw 'GetWindowRect failed' }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  # The default 3x sit frame: body at content (120,141) of 240x216 DIP.
  $bodyPoint = New-Object NativeShapeProbe+POINT
  $bodyPoint.X = $rect.Left + [int]($w * 120 / 240)
  $bodyPoint.Y = $rect.Top + [int]($h * 141 / 216)
  $padPoint = New-Object NativeShapeProbe+POINT
  $padPoint.X = $rect.Left + 2
  $padPoint.Y = $rect.Top + 2

  $bodyHwnd = [NativeShapeProbe]::WindowFromPoint($bodyPoint)
  $padHwnd = [NativeShapeProbe]::WindowFromPoint($padPoint)
  [uint32]$bodyPid = 0
  [uint32]$padPid = 0
  [NativeShapeProbe]::GetWindowThreadProcessId($bodyHwnd, [ref]$bodyPid) | Out-Null
  [NativeShapeProbe]::GetWindowThreadProcessId($padHwnd, [ref]$padPid) | Out-Null
  $result = [ordered]@{
    bodyOwnedByPet = ($bodyPid -eq $proc.Id)
    paddingFallsThrough = ($padPid -ne $proc.Id)
    petPid = $proc.Id
    bodyPid = $bodyPid
    paddingPid = $padPid
    nativeRect = @($rect.Left, $rect.Top, $w, $h)
  }
  $json = $result | ConvertTo-Json -Compress
  $json | Set-Content -LiteralPath (Join-Path $logDirFull 'native-shape.json') -Encoding UTF8
  if (-not $result.bodyOwnedByPet -or -not $result.paddingFallsThrough) { throw "native shape mismatch: $json" }
  Write-Host "PASS  native-shape     body=$($result.bodyOwnedByPet) transparentPadding=$($result.paddingFallsThrough) rect=$w`x$h"
}
finally {
  if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
  Remove-Item Env:PET_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:PET_LOG -ErrorAction SilentlyContinue
}
