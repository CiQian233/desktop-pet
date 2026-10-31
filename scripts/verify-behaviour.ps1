# Behaviour matrix check: boots the app several times with forced configs and
# asserts what the renderer reports. Covers the things a human would otherwise
# have to click through: pause/resume, every scale, every behaviour mode, drag,
# and that the pet window hugs the sprite (so clicks land on the cat).
#
#   powershell -File scripts/verify-behaviour.ps1
#   powershell -File scripts/verify-behaviour.ps1 -Exe dist\portable\CalicoPet-portable-0.1.0.exe

param(
  [string]$Exe = '',
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
$logDirFull = (Resolve-Path $LogDir).Path

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not $Exe -and -not (Test-Path $electron)) { throw "electron runtime missing: $electron" }
if ($Exe -and -not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }

# native sprite size from assets/sprites/chibi-hd/meta.json, and the window pad
$NW = 76
$NH = 68
$PAD = 6

# case name -> @{ config; probe; expect = <scriptblock taking the diag> }
# each case gets a throwaway --user-data-dir so cases cannot pollute each other
# (and so a smoke run never touches the real %APPDATA%\CalicoPet config)
$cases = @(
  @{ name = 'default-rest-3x'; config = @{}; expect = {
      param($d)
      $d.scale -eq 3 -and $d.mode -eq 'rest' -and -not $d.paused -and $d.css.w -eq ($NW * 3) } },
  @{ name = 'paused'; config = @{ paused = $true }; expect = {
      param($d) $d.paused -eq $true } },
  @{ name = 'scale-2x'; config = @{ scale = 2 }; expect = {
      param($d) $d.scale -eq 2 -and $d.css.w -eq ($NW * 2) -and $d.css.h -eq ($NH * 2) } },
  @{ name = 'scale-4x'; config = @{ scale = 4 }; expect = {
      param($d) $d.scale -eq 4 -and $d.css.w -eq ($NW * 4) -and $d.css.h -eq ($NH * 4) } },
  @{ name = 'scale-6x'; config = @{ scale = 6 }; expect = {
      param($d) $d.scale -eq 6 -and $d.css.w -eq ($NW * 6) -and $d.css.h -eq ($NH * 6) } },
  @{ name = 'mode-roam'; config = @{ mode = 'roam' }; expect = {
      param($d) $d.mode -eq 'roam' } },
  @{ name = 'mode-follow'; config = @{ mode = 'follow' }; expect = {
      param($d) $d.mode -eq 'follow' } },
  # drag must actually move the pet -- this regressed once (a stale interactive
  # flag swallowed the pointerdown) so it is checked on every run
  @{ name = 'drag-moves'; config = @{}; probe = 'drag'; expect = {
      param($d)
      $d.drag.moved -eq $true -and $d.drag.started -eq $true -and `
      $d.drag.hitAtFrom -eq $true -and $d.drag.landedAt -eq $true } },
  # the pet window must hug the sprite: that is what makes a click on the cat a
  # click on the window, with no click-through machinery involved
  @{ name = 'window-hugs-pet'; config = @{}; probe = 'window'; expect = {
      param($d) $d.windowCheck.sizedRight -eq $true } },
  # the pixel hit test must accept the cat and reject the transparent padding;
  # this is what caught the canvas-offset coordinate bug
  @{ name = 'hit-test'; config = @{}; probe = 'hittest'; expect = {
      param($d) $d.hitCheck.ok -eq $true -and $d.hitCheck.centreProbe.hit -eq $true } },
  # window motion must not oscillate. Twitching is a feedback loop, so direction
  # reversals are the real signal. Movement is judged by the total distance
  # travelled, not the displacement over the window: roam stands still between
  # destinations, so a rest inside the window can leave spanX near zero.
  @{ name = 'smooth-roam'; config = @{ mode = 'roam' }; probe = 'smooth'; expect = {
      param($d) $d.smooth.ok -eq $true -and ($d.smooth.pathX + $d.smooth.pathY) -gt 40 -and $d.smooth.maxStepY -le 260 } },
  # At fast speed the old 120ms recentre throttle moved the native window in
  # batches whose median step was ~32px. A median over moving frames is robust
  # to one OS scheduling spike while still rejecting that batchy cadence.
  @{ name = 'smooth-roam-fast'; config = @{ mode = 'roam'; roamSpeed = 'fast' }; probe = 'smooth'; smokeMs = 7000; waitMs = 35000; expect = {
      param($d) $d.smooth.ok -eq $true -and ($d.smooth.pathX + $d.smooth.pathY) -gt 40 -and $d.smooth.medianStepX -le 10 -and $d.smooth.medianStepY -le 10 } },
  @{ name = 'smooth-follow'; config = @{ mode = 'follow' }; probe = 'smooth'; expect = {
      param($d) $d.smooth.ok -eq $true -and ($d.smooth.pathX + $d.smooth.pathY) -gt 40 -and `
      $d.smooth.medianStepX -le 12 -and $d.smooth.medianStepY -le 12 } },
  # a drag must track the pointer 1:1 and never move backwards
  @{ name = 'drag-path'; config = @{}; probe = 'dragpath'; expect = {
      param($d) $d.dragPath.ok -eq $true -and $d.dragPath.backSteps -eq 0 } },
  # the alpha-silhouette hit area must sit inside the rendered sprite
  @{ name = 'hit-grid'; config = @{}; probe = 'hitgrid'; expect = {
      param($d) $d.hitGrid.ok -eq $true } },
  # walk only while the controller is moving, never while resting between legs
  @{ name = 'gait-anim'; config = @{}; probe = 'gait'; expect = {
      param($d) $d.gaitCheck.ok -eq $true } },
  # the canvas must be hit-testable: `pointer-events: none` on it makes pointer
  # events never target it, and dragging silently stops working
  @{ name = 'dom-target'; config = @{}; probe = 'domtarget'; expect = {
      param($d)
      $d.domTarget.ok -eq $true -and $d.domTarget.hitIsCanvas -eq $true -and `
      $d.domTarget.bubbled -eq $true } },
  # LONG-PRESS DRAG. This drives real pointer events through the DOM rather than
  # the renderer's test hook, because the hook cannot see: a wrong grab offset
  # (the pet then runs the wrong way), or a pointer that outruns the small pet
  # window and leaves `dragging` stuck true (the pet then ignores the mouse).
  @{ name = 'drag-pointer'; config = @{}; probe = 'dragprobe'; smokeMs = 9000; waitMs = 45000; expect = {
      param($d)
      $d.dragProbe.ok -eq $true -and $d.dragProbe.gotToFirstMove -eq $true -and `
      $d.dragProbe.gotToSecondMove -eq $true -and $d.dragProbe.stuckAfterRelease -eq $false -and `
      $d.dragProbe.releasedCleanly -eq $true -and $d.dragProbe.dragWindowDrift -le 20 -and `
      $d.dragProbe.dragWindowSettleMs -le 50 } },
  # CARRY: dragging must hold the "picked up by the scruff" pose for the WHOLE
  # drag. As a transient it expired after ~0.3s, and an idle blink could steal it.
  @{ name = 'carry-pose'; config = @{}; probe = 'carry'; smokeMs = 14000; expect = {
      param($d)
      $d.carryCheck.ok -eq $true -and $d.carryCheck.held.override -eq 'carry' -and `
      $d.carryCheck.held.persistent -eq $true } },
  # WINDOW-POSITION SYNC: the renderer converts pointer client coordinates to
  # screen coordinates with the window rectangle it knows, so that copy must stay
  # current while the window moves. When it did not, the hit test was off by up to
  # 904px and the cat could not be grabbed at all -- in every mode, which is
  # exactly what the user reported.
  @{ name = 'window-sync'; config = @{ mode = 'roam'; roamSpeed = 'fast' }; probe = 'stale'; smokeMs = 14000; expect = {
      param($d) $d.staleCheck.ok -eq $true -and $d.staleCheck.samples -gt 5 } },
  # FREE ROAM must use the WHOLE work area, not just the bottom strip: the pet
  # used to walk along the ground line only, so nothing ever moved vertically.
  @{ name = 'roam-vertical'; config = @{ mode = 'roam' }; probe = 'roam'; smokeMs = 40000; waitMs = 70000; expect = {
      param($d)
      $d.roamCheck.ok -eq $true -and $d.roamCheck.slicesVisited -ge 4 -and `
      $d.roamCheck.offFloorSamples -gt 20 -and $d.roamCheck.leftGroundBy -gt 400 } },
  # FACING is not probed separately: the drawing faces the way the cat moves, and
  # drag-pointer covers it (a leftward drag must report facing -1, a rightward one
  # +1). The mirroring itself is checked against the artwork in
  # tools/check_facing_metric.py, which is where it belongs.
  # WALK SPEED presets: slow / normal / fast must actually differ. Reads the
  # renderer's measured per-frame speed, so it is short and deterministic.
  @{ name = 'speed-slow'; config = @{ mode = 'roam'; roamSpeed = 'slow' }; probe = 'speed'; smokeMs = 12000; expect = {
      param($d) $d.speedCheck.peakSpeed -ge 45 -and $d.speedCheck.peakSpeed -le 80 } },
  @{ name = 'speed-normal'; config = @{ mode = 'roam'; roamSpeed = 'normal' }; probe = 'speed'; smokeMs = 12000; expect = {
      param($d) $d.speedCheck.peakSpeed -ge 95 -and $d.speedCheck.peakSpeed -le 150 } },
  @{ name = 'speed-fast'; config = @{ mode = 'roam'; roamSpeed = 'fast' }; probe = 'speed'; smokeMs = 12000; expect = {
      param($d) $d.speedCheck.peakSpeed -ge 175 -and $d.speedCheck.peakSpeed -le 250 } }
)

$failures = 0
foreach ($case in $cases) {
  $log = Join-Path $logDirFull "$($case.name).log"
  Remove-Item $log -Force -ErrorAction SilentlyContinue
  $env:PET_LOG = $log
  # per-case timing: probes that watch the pet for a while need a longer run
  $smokeMs = if ($case.smokeMs) { $case.smokeMs } else { 6000 }
  $waitMs = if ($case.waitMs) { $case.waitMs } else { 30000 }
  $env:PET_SMOKE_MS = "$smokeMs"
  $env:PET_TEST_CONFIG = ($case.config | ConvertTo-Json -Compress)
  if ($case.probe) { $env:PET_TEST_PROBE = $case.probe } else { Remove-Item Env:PET_TEST_PROBE -ErrorAction SilentlyContinue }

  $userData = Join-Path $logDirFull "userdata-$($case.name)"
  Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  # --user-data-dir alone is ignored once app.setName() has changed the default
  # path, so pass the explicit test-only override as well.
  $env:PET_USER_DATA_DIR = $userData
  $common = @('--user-data-dir', $userData)

  if ($Exe) {
    $proc = Start-Process -FilePath $Exe -ArgumentList $common -PassThru
  } else {
    # No -NoNewWindow: Windows PowerShell 5.1 fails to start a child when the
    # inherited environment contains case-duplicated variables such as
    # HTTPS_PROXY/https_proxy. The app writes its own log, so sharing this
    # console is not required.
    $proc = Start-Process -FilePath $electron -ArgumentList (@('.') + $common) -PassThru -WorkingDirectory $root
  }
  $proc.WaitForExit($waitMs) | Out-Null
  if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }

  $text = if (Test-Path $log) { Get-Content $log -Raw -Encoding UTF8 } else { '' }
  $m = [regex]::Match($text, '\[smoke\] renderer ready: (\{.*\})')
  if (-not $m.Success) {
    Write-Host ("FAIL  {0,-18} renderer never reported ready" -f $case.name)
    $failures++
    continue
  }
  $diag = $m.Groups[1].Value | ConvertFrom-Json
  $ok = & $case.expect $diag
  $summary = "scale={0} css={1}x{2} mode={3} paused={4} ground={5}" -f `
    $diag.scale, $diag.css.w, $diag.css.h, $diag.mode, $diag.paused, $diag.pos.ground
  if ($diag.drag) {
    $summary += " | drag dx={0} dy={1} moved={2} started={3} landedAt={4}" -f `
      $diag.drag.dx, $diag.drag.dy, $diag.drag.moved, $diag.drag.started, $diag.drag.landedAt
  }
  if ($diag.windowCheck) {
    $summary += " | window {0}x{1} sprite {2}x{3} sizedRight={4}" -f `
      $diag.windowCheck.bounds.width, $diag.windowCheck.bounds.height, `
      $diag.windowCheck.sprite.w, $diag.windowCheck.sprite.h, $diag.windowCheck.sizedRight
  }
  if ($diag.hitCheck) {
    $summary += " | hit centre={0} padding={1} pad={2}" -f `
      $diag.hitCheck.centreProbe.hit, $diag.hitCheck.paddingProbe.hit, $diag.hitCheck.pad
  }
  if ($diag.smooth) {
    $summary += " | smooth path={0}/{1} spanX={2} flipsX={3} flipsY={4} stepMed={5}/{6} stepMax={7}/{8}" -f `
      $diag.smooth.pathX, $diag.smooth.pathY, $diag.smooth.spanX, $diag.smooth.flipsX, `
      $diag.smooth.flipsY, $diag.smooth.medianStepX, $diag.smooth.medianStepY, `
      $diag.smooth.maxStepX, $diag.smooth.maxStepY
  }
  if ($diag.dragPath) {
    $summary += " | dragPath pointer={0} pet={1} back={2} winDelta={3}" -f `
      $diag.dragPath.pointerDelta, $diag.dragPath.petDelta, `
      $diag.dragPath.backSteps, $diag.dragPath.winDelta
  }
  if ($diag.hitGrid) {
    $summary += " | hitGrid hits={0} delta={1},{2} ok={3}" -f `
      $diag.hitGrid.hits, $diag.hitGrid.delta.x, $diag.hitGrid.delta.y, $diag.hitGrid.ok
  }
  if ($diag.gaitCheck) {
    $summary += " | gait rest={0} moving={1} stopped={2}" -f `
      $diag.gaitCheck.resting, $diag.gaitCheck.moving, $diag.gaitCheck.stopped
  }
  if ($diag.domTarget) {
    $summary += " | dom hit={0} bubbled={1} pointerEvents={2}" -f `
      $diag.domTarget.hitIsCanvas, $diag.domTarget.bubbled, $diag.domTarget.pointerEvents
  }
  if ($diag.dragProbe) {
    $summary += " | dragPointer first={0} second={1} stuckAfterRelease={2} clean={3} petted={4} facing={5}/{6}/{7} winDrift={8} settle={9}ms" -f `
      $diag.dragProbe.gotToFirstMove, $diag.dragProbe.gotToSecondMove, `
      $diag.dragProbe.stuckAfterRelease, $diag.dragProbe.releasedCleanly, $diag.dragProbe.pettedAfter, `
      $diag.dragProbe.facingFar, $diag.dragProbe.facingMid, $diag.dragProbe.facingThird, `
      $diag.dragProbe.dragWindowDrift, $diag.dragProbe.dragWindowSettleMs
  }
  if ($diag.roamCheck) {
    $summary += " | roam slices={0}/{1} upper={2} offFloor={3} maxStepY={4} used={5}..{6} leftGroundBy={7}" -f `
      $diag.roamCheck.slicesVisited, $diag.roamCheck.slicesAvailable, `
      $diag.roamCheck.upperHalfVisited, $diag.roamCheck.offFloorSamples, `
      $diag.roamCheck.maxStepY, $diag.roamCheck.usedTop, $diag.roamCheck.usedBottom, `
      $diag.roamCheck.leftGroundBy
  }
  if ($diag.speedCheck) {
    $summary += " | speed preset={0} peak={1}px/s" -f `
      $diag.speedCheck.preset, $diag.speedCheck.peakSpeed
  }
  if ($diag.carryCheck) {
    $summary += " | carry idle={0} held={1}(persistent {2}) released={3}" -f `
      $diag.carryCheck.idle.active, $diag.carryCheck.held.override, `
      $diag.carryCheck.held.persistent, $diag.carryCheck.released.override
  }
  if ($diag.staleCheck) {
    $summary += " | windowSync samples={0} maxDriftX={1} maxDriftY={2} (limit {3})" -f `
      $diag.staleCheck.samples, $diag.staleCheck.maxDriftX, `
      $diag.staleCheck.maxDriftY, $diag.staleCheck.limit
  }
  if ($ok) { Write-Host ("PASS  {0,-18} {1}" -f $case.name, $summary) }
  else { Write-Host ("FAIL  {0,-18} {1}" -f $case.name, $summary); $failures++ }
}

Remove-Item Env:PET_USER_DATA_DIR -ErrorAction SilentlyContinue
Write-Host ''
if ($failures -gt 0) { Write-Host "$failures case(s) failed."; exit 1 }
Write-Host "All $($cases.Count) cases passed."
exit 0
