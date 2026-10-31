import { SpriteAtlas } from './core/atlas';
import { Animator } from './core/animator';
import { PetController, TUNING } from './core/controller';
import type { FrameInfo, PetConfig } from './config-types';

const META_URL = 'sprites/pet.json';

const canvas = document.getElementById('pet') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: true })!;

let cfg: PetConfig;
let atlas: SpriteAtlas;
let anim: Animator;
let pet: PetController;
/**
 * Automated runs drive pointer events synthetically. A real cursor resting over
 * the moving window would otherwise inject trusted pointermove events into the
 * middle of a probe and overwrite its scripted path, making the result depend
 * on where the physical mouse happened to be.
 */
let testMode = false;

/** the pet window's rectangle in screen coordinates, kept up to date by main */
let windowRect = { x: 0, y: 0, width: 0, height: 0 };
let workArea = { x: 0, y: 0, width: 0, height: 0 };
let pad = 6;

let dragging = false;
let dragOffset = { x: 0, y: 0 };
let dragMoved = 0;
/** the pointer that owns the current drag, so capture can be taken/released */
let pointerId: number | null = null;
/** last time the pointer produced a drag event; a stale value means a lost drag */
let lastDragAt = 0;
/** latest pointer position in SCREEN coordinates (windowRect + client) */
let pointer = { x: 0, y: 0 };
/**
 * Global cursor position pushed by the main process. This is the source of truth
 * for follow mode; `pointer` only updates while the cursor is over the pet.
 */
let cursor = { x: 0, y: 0 };
let lastCursorSeen = 0;
/** true once the main process has delivered at least one real cursor position */
let haveCursor = false;
let lastPointerMove = performance.now();
/** travel speed measured over the last frame, px/s (published in diagnostics) */
let petSpeed = 0;
/** animation override transitions, for diagnosing a stolen held pose */
const animHistory: Array<{ t: number; override: string | null; persistent: boolean; src?: string }> = [];
let lastAnimOverride: string | null = null;
function noteAnimTransition(src?: string): void {
  const key = anim.ch.override;
  if (key === lastAnimOverride) return;
  lastAnimOverride = key;
  // a small ring buffer: enough to see who stole a pose, cheap on every frame
  animHistory.push({ t: Math.round(performance.now()), override: key, persistent: anim.ch.persistent === true, src });
  if (animHistory.length > 32) animHistory.shift();
}
/** how many window-move notifications arrived, and the last one (diagnostics) */
let windowMovedCount = 0;
let lastWindowMoved = { x: 0, y: 0 };

/** pixel-accurate sprite coverage, rebuilt when the frame or facing changes */
const MASK_CELL = 4;
let spriteMask: Uint8Array | null = null;
let maskW = 0;
let maskH = 0;
let maskKey = '';
/** scratch canvas for mask rasterisation, reused across rebuilds */
const maskCanvas = document.createElement('canvas');

/** input counters, published in diagnostics so a drag regression stays visible */
const inputStats = { down: 0, up: 0, move: 0, hit: 0, dragStarts: 0, cancel: 0, mask: false, maskCell: '' };
/** follow-mode trace, populated only when window.__petTrace is set */
const trace: Array<{
  t: number;
  target: number;
  pet: number;
  mode: string;
  y: number;
  hover: number;
  drawY: number;
  targetY: number;
}> = [];

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

interface PetDiagnostics {
  ready: boolean;
  error: string | null;
  sprites: number;
  anims: string[];
  canvas: { w: number; h: number };
  css: { w: number; h: number };
  scale: number;
  paused: boolean;
  mode: string;
  /** instantaneous travel speed, px/s: how fast the cat is actually moving */
  speed: number;
  /** the sequence on screen; `persistent` marks a held pose (drag) */
  anim?: { active: string; override: string | null; persistent: boolean };
  pos: { x: number; y: number; ground: boolean };
  facing: 1 | -1;
  roamSpeed: string;
  hitBox: { x: number; y: number; w: number; h: number } | null;
  windowRect: { x: number; y: number; width: number; height: number };
  /** window-move notifications received from main, for diagnosing input offsets */
  windowMoved?: { count: number; last: { x: number; y: number } };
  input: typeof inputStats;
  trace: Array<{
    t: number;
    target: number;
    pet: number;
    mode: string;
    y: number;
    hover: number;
    drawY: number;
    targetY: number;
  }>;
  diagFrames: number;
  follow: {
    cursor: { x: number; y: number };
    cursorAgeMs: number;
    pointer: { x: number; y: number };
    idleMs: number;
    target: number;
    hover: number;
    drawY: number;
    chasing: boolean;
  };
  /** roam-mode wander state; present so hopping can be debugged from the log */
  wander?: Record<string, unknown>;
}
declare global {
  interface Window {
    __petDiag?: PetDiagnostics;
    __petTest?: {
      beginDrag(x: number, y: number): boolean;
      updateDrag(x: number, y: number): void;
      finishDrag(): void;
      hitTest(x: number, y: number): boolean;
      info(): unknown;
      /** the artwork currently on screen, for pixel-level probes (e.g. facing) */
      currentFrame(): HTMLImageElement;
      /** config bridge, so a probe can freeze the animation while measuring */
      patch(part: Record<string, unknown>): Promise<unknown>;
      /** this work area's home corner (bottom-right), in work-area coordinates */
      home(): { x: number; y: number };
      /** raw animation channel, for diagnosing held/transient poses */
      animState(): unknown;
    };
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  atlas = await SpriteAtlas.load(META_URL);
  anim = new Animator(atlas);

  const frame = await window.pet.ready();
  cfg = frame.config;
  testMode = frame.testMode;
  applyFrame(frame);

  // The controller works in WORK-AREA (world) coordinates: that is the frame the
  // window itself is positioned in, so the pet's position and the window's
  // position live in the same space. Only drawing and hit testing convert to
  // window-local coordinates (world - windowRect).
  pet = new PetController(atlas, anim, { ...workArea }, cfg.scale, cfg.mode, cfg.roamSpeed);
  // NOTE: pet.restore() clamps against the controller's area, which is the work
  // area in the SAME (world) space as cfg.x / cfg.y -- so pass them through
  // unscaled. Mixing in window-local coordinates here caused the pet to be
  // placed far outside the window.
  const want = cfg.x != null && cfg.y != null ? { x: cfg.x, y: cfg.y } : defaultHome();
  pet.restore(want.x, want.y, cfg.facing);

  applyScale();
  layoutCanvas();
  wireIpc();
  wireInput();
  // Introspection hooks stay out of normal builds. Smoke/behaviour runs opt in
  // through main's `testMode`, so packaged users never get a global API that can
  // drive drags or mutate config from the page.
  if (frame.testMode) installTestHook();
  scheduleIdleLife();
  reportPosition(true);

  scheduleFrame(0);

  console.log(
    `[pet] 就绪：${atlas.anims.size} 组动画，原生 ${atlas.width}x${atlas.height}，` +
      `倍率 ${pet.scale}× (${pet.spriteW}x${pet.spriteH})，模式 ${pet.mode}，` +
      `窗口 ${windowRect.width}x${windowRect.height} @ ${windowRect.x},${windowRect.y}`,
  );
}

function defaultHome(): { x: number; y: number } {
  // default resting place: bottom-right, a little inset. Uses the SCALED sprite
  // width -- using the native one put the pet at the wrong place at every scale.
  const spriteW = atlas.width * cfg.scale;
  return {
    x: workArea.x + workArea.width - spriteW * 0.72,
    y: workArea.y + workArea.height,
  };
}

function applyFrame(frame: FrameInfo): void {
  windowRect = frame.windowRect;
  workArea = frame.workArea;
  pad = frame.pad;
  // the pet's position is in work-area coordinates and does NOT change when the
  // window moves -- the window is the thing that follows the pet, not vice versa
  if (pet) pet.setArea({ ...workArea });
}

/** the sprite's bottom-centre in window-local coordinates (what drawing needs) */
function localAnchor(): { x: number; y: number } {
  // pet.y is the grounded foot position; follow mode lifts the sprite with
  // `hover`, and everything visual must use the lifted position
  return { x: pet.visualX - windowRect.x, y: pet.visualY - windowRect.y };
}

/**
 * Where the sprite's bottom-centre sits in SCREEN coordinates. This is the point
 * the pointer must hit and the point the window is positioned around.
 */
function visualAnchor(): { x: number; y: number } {
  return { x: pet.visualX, y: pet.visualY };
}

/** the sprite sits bottom-centre inside the window, offset by the transparent pad */
function layoutCanvas(): void {
  // The canvas covers the WHOLE window, including its transparent pad. Drawing
  // applies the pad once, and the coordinate conversions subtract that same
  // pad. Previously the canvas was sprite-sized and shifted by `pad` in CSS,
  // while draw() also translated by `pad`: the sprite was offset twice and its
  // right/bottom edge was clipped by the smaller canvas.
  const dpr = window.devicePixelRatio || 1;
  const cssW = pet.spriteW + pad * 2;
  const cssH = pet.spriteH + pad * 2;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.style.left = '0';
  canvas.style.top = '0';
  ctx.imageSmoothingEnabled = false;
}

function applyScale(): void {
  layoutCanvas();
}

// ---------------------------------------------------------------------------
// idle life: blink now and then, doze off when nothing happens for a while
// ---------------------------------------------------------------------------

let lastInteraction = performance.now();

function scheduleIdleLife(): void {
  const blinkIn = TUNING.blinkEveryMs * (0.6 + Math.random() * 0.9);
  setTimeout(() => {
    // an idle blink must not interrupt a held pose (the cat being carried):
    // playTransient() also refuses, this just avoids the pointless call
    if (!cfg.paused && !anim.isTransient) {
      anim.playTransient('blink');
      wakeLoop();
    }
    scheduleIdleLife();
  }, blinkIn);
}

/** true during the "inhale" half of an idle cycle (drives the tiny breath scaling) */
let breathing = false;

function updateBaseAnim(): void {
  // never fight an in-flight reaction (drag/pat/land); the animator hands
  // control back on its own when the transient finishes
  if (anim.isTransient) return;
  // Walk only while the controller is ACTUALLY walking. Mode is not movement:
  // roam rests between destinations and follow stops on arrival. The old
  // mode-based test left the cat walking in place during both pauses.
  if (pet.isMoving) {
    breathing = false;
    anim.setBase('walk');
    return;
  }
  const idleFor = performance.now() - lastInteraction;
  anim.setBase(idleFor > TUNING.sleepAfterMs ? 'sleep' : 'sit');
  // breathe once per base-animation cycle while sitting still
  breathing = !pet.paused && (anim.ch.cycles & 1) === 1;
}

// ---------------------------------------------------------------------------
// ipc
// ---------------------------------------------------------------------------

function wireIpc(): void {
  window.pet.onConfig((next) => {
    const prev = cfg;
    cfg = next;
    pet.paused = next.paused;
    pet.mode = next.mode;
    if (next.scale !== prev.scale) {
      pet.setScale(next.scale);
      applyScale();
      maskKey = '';                 // sprite size changed: rebuild the hit mask
      window.pet.requestFrame();    // main resizes the window, then sends it back
    }
    // A pause still needs one last frame so the frozen pose reflects the new
    // config; an unpause must wake the loop that was stopped.
    wakeLoop(next.paused);
    // Pausing deliberately does NOT change the pose or add any badge: the pet
    // simply freezes on whatever frame it is showing.
  });

  window.pet.onFrame((info) => {
    applyFrame(info);
    wakeLoop(true);
  });

  /**
   * The main process moved the window (the pet walked, was dragged, or bounced).
   * Keeping `windowRect` current is what makes clicks land on the cat: every
   * pointer event is converted from client to screen coordinates with it, and a
   * stale copy offsets the hit test by exactly the distance the window travelled
   * -- measured up to 904px, which made the cat impossible to grab.
   */
  window.pet.onWindowMoved((origin) => {
    windowMovedCount++;
    lastWindowMoved = { ...origin };
    // This is the ACTUAL origin, not an optimistic target. Drawing must use it:
    // painting at a target the native window has not reached yet clips the cat
    // at the window edge for one frame, which reads as a twitch. Pointer input
    // no longer depends on this cache (it uses screenX/screenY), so waiting for
    // the real echo cannot break dragging.
    windowRect = { ...windowRect, x: origin.x, y: origin.y };
  });

  /**
   * The authoritative cursor position, in screen coordinates, pushed by the main
   * process. Window-local pointer events only exist while the cursor is inside
   * the pet window, so follow mode must use this instead -- otherwise the pet can
   * only track the cursor over the region its own window covers.
   */
  window.pet.onCursor((pos) => {
    cursor = pos;
    haveCursor = true;
    lastCursorSeen = performance.now();
    lastPointerMove = lastCursorSeen;
    // The loop drops to the animation's own frame rate while the cat rests. A
    // moving cursor is new work, so pull the next update forward immediately.
    if (cfg.mode === 'follow') wakeLoop();
  });

  /**
   * The pet was moved to another display (or the work area changed). The window
   * has already been repositioned by main, so this only refreshes the geometry the
   * renderer draws and hit-tests against.
   */
  window.pet.onRecenter((info) => {
    applyFrame(info);
    // the remembered world position belongs to the old display, so put the cat at
    // this work area's home corner instead of leaving it off-screen
    pet.placeDefault('br');
    pet.facing = -1;              // face inwards, away from the screen edge
    reportPosition(true);
    persistPosition(true);
    wakeLoop(true);
  });

  window.pet.onPat(() => {
    lastInteraction = performance.now();
    pet.pat();
    wakeLoop();
  });
}

/** pet position (world) at the last successful report */
let lastReported = { x: NaN, y: NaN };

/**
 * Tell main where the pet's feet are, so it can move the window to match.
 *
 * While the pet is actually moving the window must follow EVERY frame. Applying
 * the stationary 120ms throttle here made fast roam advance the native window
 * in 30px batches roughly eight times per second, which is visible as a stutter
 * even though the sprite itself moved at 60fps.
 *
 * The dead zone remains for a pet that is standing still: the window then stays
 * put instead of chasing sub-pixel breathing/rounding changes. It no longer
 * risks input feedback because pointer input uses absolute screenX/screenY.
 */
const FOLLOW_FRACTION = 0.02;
/** Minimum gap between recentres while the pet is stationary. */
const REPORT_INTERVAL_MS = 120;
let lastReportAt = 0;

function reportPosition(force = false): void {
  const visual = visualAnchor();
  const inMotion = dragging || pet.isMoving || pet.chasing || !pet.onGround;
  if (!force && !inMotion) {
    if (!Number.isNaN(lastReported.x)) {
      const limitX = pet.spriteW * FOLLOW_FRACTION;
      const limitY = pet.spriteH * FOLLOW_FRACTION;
      const withinX = Math.abs(visual.x - lastReported.x) < limitX;
      const withinY = Math.abs(visual.y - lastReported.y) < limitY;
      if (withinX && withinY) return;
      if (performance.now() - lastReportAt < REPORT_INTERVAL_MS) return;
    }
  }
  lastReportAt = performance.now();
  lastReported = { x: visual.x, y: visual.y };
  // Do not advance windowRect optimistically. The native echo is what draw()
  // can trust; painting ahead of the real window clips the sprite.
  window.pet.setPos({ x: Math.round(visual.x), y: Math.round(visual.y) });
}

let persistTimer: number | null = null;
function persistPosition(immediate = false): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  const write = () => {
    persistTimer = null;
    void window.pet.patch({
      x: Math.round(pet.visualX),
      y: Math.round(pet.visualY),
      facing: pet.facing,
    });
  };
  if (immediate) write();
  else persistTimer = window.setTimeout(write, 700);
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

/**
 * Drag handling as plain functions, so the exact production logic can be driven
 * directly by the automated probe instead of only through synthesised events.
 *
 * Coordinates here are SCREEN/(work-area) absolute. That matters: pointer events
 * are window-relative and the window is moving to follow the pet, so using the
 * raw client coordinates would feed the window's own movement back into the
 * drag and make the pet oscillate violently.
 */

/** returns true when a drag actually started */
function beginDrag(x: number, y: number): boolean {
  if (!hitTest(x, y)) return false;
  inputStats.hit++;
  lastInteraction = performance.now();
  if (cfg.paused) return false;      // frozen: no petting, no dragging
  dragging = true;
  dragMoved = 0;
  // Grab offset against the sprite's VISUAL anchor (bottom-centre). The internal
  // ground-line value is NOT where the cat is drawn, so using it made the pet
  // jump on mouse-down and drag the wrong way.
  dragOffset = { x: x - pet.visualX, y: y - pet.visualY };
  lastDragAt = performance.now();
  pet.startDrag();
  noteAnimTransition('beginDrag');
  inputStats.dragStarts++;
  if (canvas.setPointerCapture && pointerId !== null) {
    // Capture keeps move/up events coming even when the pointer outruns the
    // small pet window. Without it a fast drag leaves `dragging` stuck true and
    // the pet stops responding to the mouse for the rest of the session.
    try { canvas.setPointerCapture(pointerId); } catch { /* capture is a bonus */ }
  }
  canvas.style.cursor = 'grabbing';
  // beginDrag is also driven directly by the automated hook, which produces no
  // pointerdown. Waking here makes the loop active for every drag source, and
  // syncing the window now means the first pointermove starts from an aligned
  // frame even if the idle scheduler was between ticks.
  reportPosition(true);
  wakeLoop();
  return true;
}

function updateDrag(x: number, y: number): void {
  if (!dragging) return;
  lastDragAt = performance.now();
  const nx = x - dragOffset.x;
  const ny = y - dragOffset.y;
  dragMoved += Math.hypot(nx - pet.visualX, ny - pet.visualY);
  pet.dragTo(nx, ny);
}

function finishDrag(): void {
  if (!dragging) return;
  const wasClick = dragMoved < 7 * (window.devicePixelRatio || 1);
  dragging = false;
  if (pointerId !== null && canvas.releasePointerCapture) {
    try { canvas.releasePointerCapture(pointerId); } catch { /* already gone */ }
  }
  pointerId = null;
  canvas.style.cursor = 'grab';
  pet.endDrag();
  // Send the final position immediately. The scheduler may have been idle when
  // a hook-driven drag happened, and waiting for its next tick left the native
  // window hundreds of pixels behind the dropped cat.
  reportPosition(true);
  // the drop position is the pet's visual position; persisting the internal
  // ground-line value used to restore the cat to the wrong place
  persistPosition();
  if (wasClick) {
    lastInteraction = performance.now();
    pet.pat();
  }
}

/**
 * Pixel test against the sprite's own silhouette, not its bounding box.
 *
 * Input is window-local (what pointer events give us). The pet lives in
 * work-area coordinates and the sprite is offset by `pad` inside the window, so
 * convert: screen -> window-local -> sprite-local.
 */
function hitTest(x: number, y: number): boolean {
  // x,y are SCREEN coordinates. Build the exact rendered footprint (including
  // breath and landing squash), then inverse-map the point into the sprite's
  // unscaled pixel space where the cached mask lives. There is no window pad in
  // this conversion: the pad is applied once by draw(), not to the artwork.
  const metrics = renderMetrics();
  if (
    x < metrics.left ||
    x > metrics.left + metrics.drawW ||
    y < metrics.top ||
    y > metrics.top + metrics.drawH
  ) {
    return false;
  }
  const sx = ((x - metrics.left) / metrics.drawW) * pet.spriteW;
  const sy = ((y - metrics.top) / metrics.drawH) * pet.spriteH;
  if (spriteMask) {
    const cx = Math.floor(sx / MASK_CELL);
    const cy = Math.floor(sy / MASK_CELL);
    if (cx < 0 || cy < 0 || cx >= maskW || cy >= maskH) return false;
    return spriteMask[cy * maskW + cx] === 1;
  }
  return true;
}

function installTestHook(): void {
  window.__petTest = {
    beginDrag,
    updateDrag,
    finishDrag,
    hitTest,
    currentFrame: () => anim.currentFrame(),
    patch: (part: Record<string, unknown>) => window.pet.patch(part),
    home: () => defaultHome(),
    animState: () => ({
      ...anim.ch,
      channel: anim.active().label,
      hasCarry: atlas.anims.has('carry'),
      dragging,
      // every override transition since boot, with the frame time: this is what
      // shows WHO stole a held pose (a diagnostic snapshot would miss it)
      history: animHistory.slice(-24),
    }),
    info: () => ({
      dragging,
      // visual position == the sprite's bottom-centre; follow/roam move it about
      pet: { x: pet.visualX, y: pet.visualY, scale: pet.scale, hover: pet.hover },
      offset: { ...dragOffset },
      // 1 = facing right, -1 = facing left (the artwork itself faces left)
      facing: pet.facing,
      mode: pet.mode,
      windowRect,
      local: localAnchor(),
      stats: { ...inputStats },
    }),
    /** debug hook: step the follow logic directly and report what changed */
    stepChase: (px: number, py: number, dt = 0.016) => {
      const before = { x: pet.x, y: pet.drawY, hover: pet.hover };
      (pet as unknown as { chase: (dt: number, q: { x: number; y: number }) => void }).chase(dt, {
        x: px,
        y: py,
      });
      return { before, after: { x: pet.x, y: pet.drawY, hover: pet.hover } };
    },
  } as unknown as NonNullable<Window['__petTest']>;
}

function wireInput(): void {
  canvas.style.cursor = 'grab';

  // Use the event's absolute screen coordinates. clientX/clientY are relative
  // to a window that is itself moving under the pointer; during a fast drag
  // Windows synthesises new client coordinates for a stationary cursor, which
  // fed the window's own motion back into dragTo() and made the pet oscillate.
  // screenX/screenY are invariant while the window moves.
  const screenPos = (e: PointerEvent | MouseEvent) => ({ x: e.screenX, y: e.screenY });

  window.addEventListener('pointerdown', (e) => {
    if (testMode && e.isTrusted) return;
    inputStats.down++;
    if (e.button !== 0) return;
    const p = screenPos(e);
    pointer = p;
    lastPointerMove = performance.now();
    pointerId = e.pointerId;
    if (beginDrag(p.x, p.y)) {
      wakeLoop();
      e.preventDefault();
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (testMode && e.isTrusted) return;
    inputStats.move++;
    const p = screenPos(e);
    const changed = p.x !== pointer.x || p.y !== pointer.y;
    pointer = p;
    lastPointerMove = performance.now();
    // Windows synthesises pointermove events when the window moves underneath
    // a stationary cursor. They carry a new clientX/clientY but the SAME
    // screenX/screenY. Ignoring them prevents both drag feedback and endless
    // refresh of the lost-pointer watchdog while the cat is moving.
    if (dragging && changed) updateDrag(p.x, p.y);
  });

  window.addEventListener('pointerup', (e) => {
    if (testMode && e.isTrusted) return;
    inputStats.up++;
    if (!dragging) return;
    finishDrag();
    e.preventDefault();
  });

  // A drag must never outlive its pointer. Releasing the button outside the pet
  // window (easy: the window is only the size of the cat) delivered no pointerup
  // here at all, and `dragging` stayed true forever -- after that the pet ignored
  // every click. These three listeners end the drag in each loss case.
  window.addEventListener('pointercancel', (e) => {
    if (testMode && e.isTrusted) return;
    inputStats.cancel++;
    if (dragging) finishDrag();
  });
  window.addEventListener('blur', () => {
    if (testMode) return;
    if (dragging) finishDrag();
  });
  document.addEventListener('mouseleave', () => {
    if (testMode) return;
    // the button is no longer down: a drag that produced no events has died
    if (dragging && (performance.now() - lastDragAt > 400)) finishDrag();
  });

  window.addEventListener('dblclick', (e) => {
    if (testMode && e.isTrusted) return;
    if (cfg.paused) return;
    const p = screenPos(e);
    if (!hitTest(p.x, p.y)) return;
    lastInteraction = performance.now();
    pet.anger();
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.pet.openMenu();
  });

  // stop the page from scrolling / selecting / dragging
  window.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  window.addEventListener('resize', () => {
    void window.pet.ready().then((f) => {
      applyFrame(f);
      wakeLoop(true);
    });
  });
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

let last = performance.now();
let nextDiagAt = 250;
let diagFrames = 0;
/** dirty flag for draw(): everything draw() consumes, keyed; '' forces a draw */
let lastDrawKey = '';

// ---------------------------------------------------------------------------
// frame scheduler
//
// A display-refresh loop running forever costs CPU even when draw() is clean,
// and on a 165Hz screen it also moves the native window far more often than the
// eye or the animation needs. Motion is capped at 60Hz, a sitting cat runs at
// its 2.2fps animation rate, and a paused cat stops completely. Input/IPC paths
// call wakeLoop() when new work arrives.
// ---------------------------------------------------------------------------

const MOTION_FRAME_MS = 1000 / 60;
let frameTimer: number | null = null;
let frameDueAt = 0;

function scheduleFrame(delayMs: number): void {
  if (frameTimer !== null) return;
  frameDueAt = performance.now() + delayMs;
  frameTimer = window.setTimeout(() => {
    frameTimer = null;
    frameDueAt = 0;
    // Timer-driven rather than rAF-driven on purpose. rAF follows the display
    // refresh (165Hz here), so moving the native window on every callback sent
    // ~170 IPC position updates per second and starved the main process. 60Hz
    // is both the authored animation rate and enough for smooth motion.
    loop(performance.now());
  }, Math.max(0, delayMs));
}

/** Bring the next update forward; force=true also runs one frame while paused. */
function wakeLoop(force = false): void {
  if (!cfg) return;
  if (cfg.paused && !force) return;
  if (frameTimer !== null) {
    if (frameDueAt - performance.now() < 6) return; // a frame is already imminent
    window.clearTimeout(frameTimer);
    frameTimer = null;
    frameDueAt = 0;
  }
  // Time spent stopped must not arrive as one giant animation step.
  last = performance.now();
  scheduleFrame(0);
}

function scheduleNextFrame(probeAttached: boolean): void {
  if (!cfg || cfg.paused) return;
  const moving =
    dragging ||
    pet.isMoving ||
    pet.chasing ||
    !pet.onGround ||
    pet.squashFactor > 0.001;
  if (moving || probeAttached) {
    scheduleFrame(MOTION_FRAME_MS);
    return;
  }
  // A blink or pat is an animation-only change: run it at its authored frame
  // rate instead of repainting the whole motion loop for a 3–8fps sequence.
  const fps = Math.max(0.5, anim.active().fps);
  scheduleFrame(Math.min(750, Math.max(32, 1000 / fps)));
}

function loop(now: number): void {
  // Physics is clamped so a stall cannot teleport the cat; animation uses the
  // real elapsed time so lowering the idle tick rate does not slow it down.
  const rawDt = Math.min(1, Math.max(0, (now - last) / 1000));
  const dt = Math.min(0.05, rawDt);
  last = now;

  // A drag whose pointer events have stopped arriving (button released outside
  // the pet window, pointer lost, window moved out from under the cursor) must
  // end here: otherwise `dragging` stays true and the pet stops taking clicks.
  if (dragging && now - lastDragAt > 1500) finishDrag();

  if (!cfg.paused) updateBaseAnim();

  // Follow mode always uses the GLOBAL cursor, even if it has not moved for a
  // while. It must never fall back to window-local pointer events: those only
  // arrive while the cursor is over the pet window, and before the first real
  // move they hold a stale (0,0) which sent the pet sprinting to the corner.
  // A stationary cursor simply means the pet has nowhere to go.
  const track = cfg.mode === 'follow' && haveCursor ? cursor : pointer;
  const beforeX = pet.visualX;
  const beforeY = pet.visualY;
  // An exception thrown by the controller would otherwise kill the animation
  // frame and freeze the pet silently, with nothing in the log to explain it.
  try {
    pet.update(dt, {
      dragging,
      pointer: track,
      pointerIdleMs: now - lastPointerMove,
      roamSpeed: cfg.roamSpeed,
    });
  } catch (err) {
    console.error('[pet] controller update failed:', err);
  }
  // measured, not assumed: reports what the frame actually did, which is what
  // makes the roam-speed presets testable
  petSpeed = dt > 0 ? Math.hypot(pet.visualX - beforeX, pet.visualY - beforeY) / dt : 0;

  // follow-mode trace, for the automated probe only
  if (cfg.mode === 'follow' && (window as unknown as { __petTrace?: boolean }).__petTrace) {
    trace.push({
      t: Math.round(now),
      target: Math.round(track.x),
      pet: Math.round(pet.visualX),
      mode: pet.mode,
      // vertical state, so a pinned hover or a wandering y is visible
      y: Math.round(pet.y),
      hover: Math.round(pet.hover),
      drawY: Math.round(pet.drawY),
      targetY: Math.round(track.y),
    });
    if (trace.length > 400) trace.shift();
  }
  anim.update(rawDt, cfg.paused);       // frozen while paused, so the frame holds
  noteAnimTransition();

  const local = localAnchor();
  const frame = anim.currentFrame();
  // The mask lives in SPRITE-LOCAL space, so only the frame, the facing (the
  // mirroring) and the scale can change its content. Position is deliberately
  // NOT part of the key: it changes every frame while the pet walks or is
  // dragged, and rebuilding meant a full getImageData readback per frame.
  const key = `${frame.src}|${pet.facing}|${pet.scale}`;
  if (key !== maskKey) {
    buildMask(frame, pet.facing > 0);
    maskKey = key;
  }

  // keep the window glued to the pet: this is what makes clicks land on the cat
  reportPosition();

  // Repaint only when something draw() consumes actually changed: the frame,
  // its placement, the facing/scale (in `key`), the breath phase, the squash
  // decay, or the device pixel ratio. A sitting or PAUSED pet changes none of
  // these, so its canvas keeps its last pixels instead of being cleared and
  // redrawn 60 times a second -- that full-rate redraw was pure idle cost.
  const drawKey =
    `${key}|${Math.round(local.x)}|${Math.round(local.y)}` +
    `|${breathing ? 1 : 0}|${Math.round(pet.squashFactor * 1000)}|${window.devicePixelRatio || 1}`;
  if (drawKey !== lastDrawKey) {
    lastDrawKey = drawKey;
    draw(frame);
  }

  // publish continuously while a probe is attached, so a frozen snapshot means
  // the loop really stopped rather than "we only sampled once"
  const probeAttached = (window as unknown as { __petTrace?: boolean }).__petTrace === true;
  if (probeAttached || now >= nextDiagAt) {
    // Keep the snapshot reasonably fresh. It used to be published once and
    // then never again, which made any later probe read a boot-time snapshot.
    nextDiagAt = now + 250;
    diagFrames++;
    publishDiagnostics();
  }
  scheduleNextFrame(probeAttached);
}

// ---------------------------------------------------------------------------
// drawing helpers
// ---------------------------------------------------------------------------

/**
 * Rasterise the current frame once per (frame, facing, scale) and remember
 * which cells hold a visible pixel, so clicks only "land" on the cat's body.
 * Cells are in sprite-local space. `flip` mirrors the artwork, which is drawn
 * facing LEFT, so it is true whenever the cat faces right.
 */
function buildMask(img: HTMLImageElement, flip: boolean): void {
  const w = pet.spriteW;
  const h = pet.spriteH;
  // size in CSS pixels on purpose: hitTest converts the pointer into CSS-pixel
  // sprite coordinates, so the mask must be indexed in those units (sizing it in
  // device pixels would still give the right cell count at dpr=1, which is why
  // this looked fine, but it would break on a scaled display).
  // Resizing also wipes the canvas and resets its context state, which is what
  // makes reuse safe between rebuilds of different scales.
  maskCanvas.width = w;
  maskCanvas.height = h;
  const octx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
  octx.imageSmoothingEnabled = false;
  // the sprite is drawn bottom-centred on its own canvas; mirror it around that
  // canvas's own centre in a single pass when the cat faces right
  if (flip) {
    octx.save();
    octx.translate(w, 0);
    octx.scale(-1, 1);
    octx.drawImage(img, 0, 0, w, h);
    octx.restore();
  } else {
    octx.drawImage(img, 0, 0, w, h);
  }
  maskW = Math.ceil(w / MASK_CELL);
  maskH = Math.ceil(h / MASK_CELL);
  const data = octx.getImageData(0, 0, w, h).data;
  const next = new Uint8Array(maskW * maskH);
  const need = Math.max(3, Math.floor((MASK_CELL * MASK_CELL) / 3));
  for (let cy = 0; cy < maskH; cy++) {
    for (let cx = 0; cx < maskW; cx++) {
      let hits = 0;
      const x0 = cx * MASK_CELL;
      const y0 = cy * MASK_CELL;
      for (let y = y0; y < Math.min(y0 + MASK_CELL, h); y++) {
        for (let x = x0; x < Math.min(x0 + MASK_CELL, w); x++) {
          if (data[(y * w + x) * 4 + 3] > 24) hits++;
        }
      }
      if (hits >= need) next[cy * maskW + cx] = 1;
    }
  }
  spriteMask = next;
  inputStats.mask = true;
  inputStats.maskCell = `${maskW}x${maskH}`;
}

/**
 * The exact on-screen footprint of the current frame, in screen coordinates.
 * Draw and hitTest both consume this, so a change to breath/squash can never
 * make the clickable cat drift away from the drawn one.
 */
function renderMetrics(): { drawW: number; drawH: number; left: number; top: number } {
  const breath = breathing ? 1 : 0;
  const squash = pet.squashFactor;
  // Both effects are anchored at the feet, so they change size but not the
  // bottom-centre position. Breathing is intentionally only a few thousandths.
  const drawW = pet.spriteW * (1 - breath * 0.004) * (1 + squash * 0.18);
  const drawH = pet.spriteH * (1 - breath * 0.012) * (1 - squash * 0.32);
  return {
    drawW,
    drawH,
    left: pet.visualX - drawW / 2,
    top: pet.visualY - drawH,
  };
}

function draw(frame: HTMLImageElement): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // clear the whole backing store, in CSS pixels: canvas.width / dpr. Clearing
  // by the raw device size only happened to be correct because dpr is 1 here,
  // and on a scaled display it would wipe the wrong area.
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  const metrics = renderMetrics();

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  // Bottom-centre of the sprite in WINDOW-LOCAL coordinates. Use the live
  // anchor rather than pad+w/2: while the window follows the pet it can lag by
  // the dead-zone amount, and drawing at a fixed spot would then put the pixels
  // a few px away from the screen position hitTest uses.
  const local = localAnchor();
  ctx.translate(local.x, local.y);
  // facing: mirror around the sprite's own centre. The artwork faces LEFT, so
  // facing RIGHT (facing > 0) is the mirrored case.
  if (pet.facing > 0) ctx.scale(-1, 1);
  ctx.drawImage(frame, -metrics.drawW / 2, -metrics.drawH, metrics.drawW, metrics.drawH);
  ctx.restore();
}

function publishDiagnostics(): void {
  window.__petDiag = {
    ready: true,
    error: null,
    sprites: atlas.anims.size,
    anims: [...atlas.anims.keys()],
    canvas: { w: canvas.width, h: canvas.height },
    css: { w: pet.spriteW, h: pet.spriteH },
    scale: pet.scale,
    paused: cfg.paused,
    mode: pet.mode,
    speed: Math.round(petSpeed),
    /** which sequence is actually on screen, and whether it is held or transient */
    anim: { active: anim.active().label, override: anim.ch.override, persistent: anim.ch.persistent === true },
    pos: { x: Math.round(pet.visualX), y: Math.round(pet.visualY), ground: pet.onGround },
    facing: pet.facing,
    roamSpeed: pet.roamSpeed,
    hitBox: {
      x: Math.round(pet.visualX - pet.spriteW / 2),
      y: Math.round(pet.visualY - pet.spriteH),
      w: Math.round(pet.spriteW),
      h: Math.round(pet.spriteH),
    },
    windowRect: { ...windowRect },
    windowMoved: { count: windowMovedCount, last: { ...lastWindowMoved } },
    input: { ...inputStats },
    follow: {
      cursor: { x: Math.round(cursor.x), y: Math.round(cursor.y) },
      cursorAgeMs: Math.round(performance.now() - lastCursorSeen),
      pointer: { x: Math.round(pointer.x), y: Math.round(pointer.y) },
      idleMs: Math.round(performance.now() - lastPointerMove),
      target: cfg.mode === 'follow' && haveCursor ? Math.round(cursor.x) : Math.round(pointer.x),
      hover: Math.round(pet.hover),
      drawY: Math.round(pet.drawY),
      chasing: pet.chasing,
    },
    wander: pet.wanderDebug,
    trace: trace.slice(-40),
    diagFrames,
  };
}

// ---------------------------------------------------------------------------

boot().catch((err) => {
  console.error('[pet] 启动失败:', err);
  document.title = '桌宠启动失败';
});
