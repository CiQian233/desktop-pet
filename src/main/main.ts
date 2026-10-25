/**
 * CalicoPet main process.
 *
 * Architecture note (important for future changes):
 * the pet lives in a SMALL window that is just big enough for the sprite plus a
 * few pixels of padding, and that window follows the pet around the work area.
 * Input is therefore completely ordinary: a click on the cat is a click on the
 * window, with no click-through state to toggle.
 *
 * This replaced a full-screen transparent overlay. That overlay needed
 * `setIgnoreMouseEvents` to be flipped continuously, and on Windows
 * `setIgnoreMouseEvents(true, { forward: true })` left the window permanently
 * click-through, so real clicks never reached the pet. A pet-sized window has no
 * such failure mode.
 */

import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  Tray,
  app,
  ipcMain,
  nativeImage,
  screen,
  type Rectangle,
} from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigStore, type PetConfig, type PetMode, type PetScale, type RoamSpeed } from './config';

const APP_DIR = app.getAppPath();
const IS_PACKED = app.isPackaged;
const RENDERER_HTML = join(APP_DIR, 'dist', 'renderer', 'renderer', 'index.html');

// Keep the userData directory identical between `electron .` and the packaged
// exe, otherwise dev runs and installed runs would keep separate configs (and
// leave a stray %APPDATA%\desktop-pet behind).
app.setName('CalicoPet');

/** native sprite dimensions -- must match assets/sprites/pet.json */
const SPRITE_NATIVE = { w: 76, h: 68 };
/** transparent margin around the sprite, inside the window */
const WINDOW_PAD = 6;

/** PET_SMOKE_MS=4000 boots the app, reports, then quits -- used by scripts/smoke.ps1 */
const SMOKE_MS = Number(process.env.PET_SMOKE_MS ?? 0) || 0;

/** PET_TEST_CONFIG='{"paused":true,"scale":4}' forces a config for a smoke run */
const TEST_CONFIG: Partial<PetConfig> = (() => {
  const raw = process.env.PET_TEST_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<PetConfig>;
  } catch (err) {
    console.error('[main] PET_TEST_CONFIG is not valid JSON:', err);
    return {};
  }
})();

/** PET_TEST_PROBE=<name> runs a named interaction check after boot */
const TEST_PROBE = process.env.PET_TEST_PROBE ?? '';

/** PET_LOG=<file> tees main-process logs to a file (a packaged exe has no console) */
const LOG_FILE = process.env.PET_LOG ?? '';
if (LOG_FILE) {
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${args
      .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`;
    try {
      appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
      /* logging must never break the app */
    }
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(level, args);
      original(...args);
    };
  }
  process.on('uncaughtException', (err) => {
    write('fatal', [err]);
    app.exit(1);
  });
}

const store = new ConfigStore();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let windowOrigin = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function activeArea(): Rectangle {
  const cfg = store.all();
  const display =
    cfg.displayId != null
      ? screen.getAllDisplays().find((d) => d.id === cfg.displayId) ?? screen.getPrimaryDisplay()
      : screen.getPrimaryDisplay();
  return display.workArea;
}

function spriteSize(scale: PetScale): { w: number; h: number } {
  return { w: SPRITE_NATIVE.w * scale, h: SPRITE_NATIVE.h * scale };
}

function windowSize(scale: PetScale): { w: number; h: number } {
  const s = spriteSize(scale);
  return { w: s.w + WINDOW_PAD * 2, h: s.h + WINDOW_PAD * 2 };
}

/** default resting place: bottom-right of the work area, a little inset */
function homeAnchor(area: Rectangle, scale: PetScale): { x: number; y: number } {
  const s = spriteSize(scale);
  return {
    x: area.x + area.width - s.w * 0.72,
    y: area.y + area.height,
  };
}

/**
 * Place the window so the pet anchor lands at (anchorX, anchorY) in work-area
 * coordinates.
 *
 * Uses setPosition rather than setBounds: this runs every frame while the pet
 * walks or is dragged, and setBounds re-does a full move+resize which made the
 * window visibly stutter on Windows. The size only changes when the scale does.
 *
 * The new origin is ECHOED BACK to the renderer. That is not an optimisation: the
 * renderer converts pointer client coordinates into screen coordinates with the
 * window rectangle it knows, and it only learns about a move when we tell it.
 * Without this echo its copy stayed at the boot position forever -- measured up
 * to 904px away from the real window -- so every hit test was computed at the
 * wrong place and the cat could not be grabbed at all.
 */
function moveWindowToAnchor(anchorX: number, anchorY: number): void {
  if (!win) return;
  moveStats.requested++;
  const scale = store.all().scale;
  const s = spriteSize(scale);
  const x = Math.round(anchorX - WINDOW_PAD - s.w / 2);
  const y = Math.round(anchorY - WINDOW_PAD - s.h);
  if (x === windowOrigin.x && y === windowOrigin.y) {
    moveStats.deduped++;
    return;
  }
  windowOrigin = { x, y };
  win.setPosition(x, y);
  moveStats.sent++;
  win.webContents.send('pet:windowMoved', { x, y });
}

function currentWindowRect(): Rectangle {
  const { w, h } = windowSize(store.all().scale);
  return { x: windowOrigin.x, y: windowOrigin.y, width: w, height: h };
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow(): void {
  const cfg = store.all();
  const area = activeArea();
  const s = spriteSize(cfg.scale);
  const { w, h } = windowSize(cfg.scale);

  const anchor = cfg.x != null && cfg.y != null
    ? { x: cfg.x, y: cfg.y }
    : homeAnchor(area, cfg.scale);

  const x = Math.round(anchor.x - WINDOW_PAD - s.w / 2);
  const y = Math.round(anchor.y - WINDOW_PAD - s.h);
  windowOrigin = { x, y };

  win = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    alwaysOnTop: cfg.alwaysOnTop,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // no input gymnastics needed any more: the window IS the cat
  win.setIgnoreMouseEvents(false);

  win.once('ready-to-show', () => win?.showInactive());
  win.on('closed', () => {
    win = null;
  });

  win.on('moved', () => {
    if (win) {
      const b = win.getBounds();
      windowOrigin = { x: b.x, y: b.y };
    }
  });

  if (!existsSync(RENDERER_HTML)) {
    console.error('[main] renderer bundle missing at', RENDERER_HTML);
  }
  void win.loadFile(RENDERER_HTML);

  if (process.env.PET_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', details.reason);
  });

  // surface renderer console output in the main log; a packaged build has no
  // devtools, so this is the only way to see renderer errors
  win.webContents.on('console-message', (...args: unknown[]) => {
    const a = args as [unknown, unknown, unknown?, unknown?, unknown?];
    let level: number | string = 0;
    let message = '';
    let source = '';
    let line = 0;
    if (typeof a[1] === 'object' && a[1] !== null) {
      const d = a[1] as { level?: number | string; message?: string; sourceId?: string; lineNumber?: number };
      level = d.level ?? 0;
      message = d.message ?? '';
      source = d.sourceId ?? '';
      line = d.lineNumber ?? 0;
    } else {
      level = (a[1] as number) ?? 0;
      message = String(a[2] ?? '');
      line = Number(a[3] ?? 0);
      source = String(a[4] ?? '');
    }
    const isError = level === 3 || level === 'error' || level === 2 || level === 'warning';
    console[isError ? 'error' : 'log'](`[renderer] ${message} (${source}:${line})`);
  });

  win.webContents.on('did-finish-load', () => {
    // the window exists now: start (or restart) the cursor feed for follow mode.
    // Calling this only from applyConfig was not enough -- that runs before the
    // window is created, so the feed never started and follow fell back to
    // stale window-local pointer events.
    syncCursorPolling();
    if (SMOKE_MS > 0) startSmokeRun();
  });
}

/** shown to the renderer on boot and whenever the frame changes */
function frameInfo(): Record<string, unknown> {
  const area = activeArea();
  return {
    config: store.all(),
    windowRect: currentWindowRect(),
    workArea: area,
    pad: WINDOW_PAD,
    version: app.getVersion(),
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function patch(part: Partial<PetConfig>): PetConfig {
  const next = store.patch(part);
  applyConfig(next);
  return next;
}

function applyConfig(cfg: PetConfig): void {
  if (win) {
    win.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
    const { w, h } = windowSize(cfg.scale);
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    win.webContents.send('config:changed', { ...cfg });
  }
  tray?.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  syncCursorPolling();
}

// ---------------------------------------------------------------------------
// Global cursor feed
//
// "Follow the mouse" cannot be driven by window-local pointer events: they only
// arrive while the cursor is inside the pet's small window, so tracking worked
// only in the region the window happened to cover. The main process can read the
// cursor for the WHOLE screen, so it pushes the position down instead. This is
// the architectural fix for "it only follows the cursor in some places".
// ---------------------------------------------------------------------------

let cursorTimer: NodeJS.Timeout | null = null;
let lastCursorSent = { x: NaN, y: NaN };
/** diagnostics: how many cursor samples were read and actually delivered */
const cursorStats = { polls: 0, sent: 0, skipped: 0 };
/** diagnostics: window moves requested vs. echoed to the renderer */
const moveStats = { requested: 0, sent: 0, deduped: 0 };

function pushCursor(): void {
  cursorStats.polls++;
  if (!win || win.isDestroyed()) {
    cursorStats.skipped++;
    return;
  }
  const p = screen.getCursorScreenPoint();
  if (p.x === lastCursorSent.x && p.y === lastCursorSent.y) {
    cursorStats.skipped++;
    return;
  }
  lastCursorSent = p;
  cursorStats.sent++;
  win.webContents.send('pet:cursor', p);
}

/** follow needs a live cursor; other modes get it from the window's own events */
function syncCursorPolling(): void {
  const cfg = store.all();
  const needs = cfg.mode === 'follow' && !cfg.paused;
  if (needs && !cursorTimer) {
    cursorTimer = setInterval(pushCursor, 40);
    pushCursor();
  } else if (!needs && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
    lastCursorSent = { x: NaN, y: NaN };
  }
}

function togglePaused(): void {
  patch({ paused: !store.all().paused });
}

function applyAutostart(enabled: boolean): void {
  try {
    // A portable build runs from a temp folder that the launcher deletes the
    // moment the app exits, so registering process.execPath would write a Run
    // entry pointing at a path that no longer exists -- autostart would then
    // silently do nothing on the next boot. The portable launcher exports the
    // real .exe location in PORTABLE_EXECUTABLE_FILE; prefer it when present.
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    const usePortableLauncher = Boolean(portableExe && existsSync(portableExe));
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: usePortableLauncher ? (portableExe as string) : process.execPath,
      args: usePortableLauncher || IS_PACKED ? [] : [APP_DIR],
    });
  } catch (err) {
    console.error('[main] autostart failed:', err);
  }
}

// ---------------------------------------------------------------------------
// tray + context menu
// ---------------------------------------------------------------------------

function trayImage(): Electron.NativeImage {
  const file = IS_PACKED
    ? join(process.resourcesPath, 'app.asar', 'assets', 'tray.png')
    : join(APP_DIR, 'assets', 'tray.png');
  const img = nativeImage.createFromPath(existsSync(file) ? file : join(APP_DIR, 'assets', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildMenuTemplate(): MenuItemConstructorOptions[] {
  const cfg = store.all();
  const modes: Array<[PetMode, string]> = [
    ['rest', '原地待机'],
    ['roam', '自由走动'],
    ['follow', '跟着鼠标'],
  ];
  const scales: PetScale[] = [2, 3, 4, 6];
  const roamSpeeds: Array<[RoamSpeed, string]> = [
    ['slow', '慢'],
    ['normal', '中'],
    ['fast', '快'],
  ];

  return [
    { label: cfg.paused ? '继续动作' : '暂停动作', click: () => togglePaused() },
    { type: 'separator' },
    {
      label: '行为模式',
      submenu: modes.map(([value, label]) => ({
        label,
        type: 'radio' as const,
        checked: cfg.mode === value,
        click: () => patch({ mode: value }),
      })),
    },
    {
      label: '走路速度',
      submenu: roamSpeeds.map(([value, label]) => ({
        label,
        type: 'radio' as const,
        checked: cfg.roamSpeed === value,
        click: () => patch({ roamSpeed: value }),
      })),
    },
    {
      label: '显示倍率',
      submenu: scales.map((value) => ({
        label: `${value}\u00d7`,
        type: 'radio' as const,
        checked: cfg.scale === value,
        click: () => patch({ scale: value }),
      })),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: cfg.autostart,
      click: (item) => {
        patch({ autostart: item.checked });
        applyAutostart(item.checked);
      },
    },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: cfg.alwaysOnTop,
      click: (item) => patch({ alwaysOnTop: item.checked }),
    },
    { type: 'separator' },
    {
      label: '移到主显示器',
      click: () => {
        // clears the remembered position, so the pet restarts on the target
        // display instead of at coordinates that belonged to the old one
        patch({ displayId: screen.getPrimaryDisplay().id, x: null, y: null });
        switchToPrimaryDisplay();
      },
    },
    { type: 'separator' },
    { label: `CalicoPet v${app.getVersion()}`, enabled: false },
    { label: '退出', click: () => app.quit() },
  ];
}

/**
 * Put the pet on the configured display's home corner and tell the renderer.
 *
 * There is deliberately NO "back to the bottom-right corner" menu item any more:
 * it was removed at the user's request after it kept appearing to do nothing.
 * The pet's position is persisted, so a menu item that only moved the window was
 * undone by the next report anyway.
 */
function switchToPrimaryDisplay(): void {
  const area = activeArea();
  const cfg = store.all();
  const home = homeAnchor(area, cfg.scale);
  moveWindowToAnchor(home.x, home.y);
  win?.webContents.send('pet:recenter', frameInfo());
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip('桌宠猫咪 · 左键摸头 / 右键菜单');
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  tray.on('click', () => win?.webContents.send('pet:pat'));
}

function popupMenu(): void {
  if (!win) return;
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
}

// ---------------------------------------------------------------------------
// ipc
// ---------------------------------------------------------------------------

function registerIpc(): void {
  /** the renderer tells us where the pet's feet are (work-area coordinates) */
  ipcMain.on('pet:pos', (_e, pos: { x: number; y: number }) => {
    moveWindowToAnchor(pos.x, pos.y);
  });

  /** the renderer reports its sprite size so the window can be sized to match */
  ipcMain.handle('app:ready-bundle', () => frameInfo());

  ipcMain.handle('config:patch', (_e, part: Partial<PetConfig>) => patch(part));

  ipcMain.on('app:openMenu', () => popupMenu());

  ipcMain.on('app:quit', () => app.quit());

  /**
   * The window's REAL screen bounds, answered synchronously.
   *
   * Only the automated probes use this, to measure how far the renderer's idea of
   * the window is from the real one at a single instant. An async round trip would
   * let the window move in between, and comparing samples from different moments
   * measures the pet's travel rather than the lag.
   */
  ipcMain.on('pet:realBounds', (e) => {
    e.returnValue = win?.getBounds() ?? null;
  });

  // window resized under us (scale change completed) -> tell the renderer
  ipcMain.on('pet:requestFrame', () => {
    win?.webContents.send('pet:frame', frameInfo());
  });
}

// ---------------------------------------------------------------------------
// smoke-run probe (automated verification; see scripts/)
// ---------------------------------------------------------------------------

interface SmokeDiag {
  ready: boolean;
  canvas: { w: number; h: number };
  css: { w: number; h: number };
  scale: number;
  paused: boolean;
  mode: string;
  pos: { x: number; y: number; ground: boolean };
  hitBox: { x: number; y: number; w: number; h: number } | null;
  input?: Record<string, unknown>;
}

function startSmokeRun(): void {
  const deadline = Date.now() + SMOKE_MS;
  let probeDone = false;
  const poll = () => {
    win?.webContents
      .executeJavaScript('window.__petDiag ?? null')
      .then(async (diag: SmokeDiag | null) => {
        if (diag && diag.ready) {
          if (TEST_PROBE && !probeDone) {
            probeDone = true;
            try {
              const outcome = await runProbe(diag);
              console.log('[smoke] renderer ready:', JSON.stringify({ ...diag, ...outcome }));
            } catch (err) {
              console.error('[probe] failed:', err);
              app.exit(4);
              return;
            }
            setTimeout(() => app.quit(), 200);
            return;
          }
          console.log('[smoke] renderer ready:', JSON.stringify(diag));
          console.log('[smoke] window bounds:', JSON.stringify(win?.getBounds()));
          setTimeout(() => app.quit(), 300);
        } else if (Date.now() > deadline) {
          console.error('[smoke] renderer never became ready within', SMOKE_MS, 'ms');
          app.exit(2);
        } else {
          setTimeout(poll, 200);
        }
      })
      .catch((err) => {
        console.error('[smoke] probe failed:', err);
        app.exit(3);
      });
  };
  setTimeout(poll, 400);
}

async function runProbe(diag: SmokeDiag): Promise<Record<string, unknown>> {
  /**
   * Evaluate a snippet in the renderer.
   *
   * Two shapes are accepted:
   *   * a plain expression or statement list -- `js('window.__petDiag ?? null')`,
   *     `js('window.__petTrace = true;')`
   *   * a FUNCTION expression, which is called with `arg` -- `js('(P) => { ... }', { ... })`
   *
   * All probe snippets are written in the function form, so they can take
   * parameters. Guessing the shape from punctuation was tried and got it wrong
   * for `(() => { ... })()` snippets, so the rule is now positional and simple.
   */
  const js = (expr: string, arg?: unknown) => {
    const trimmed = expr.trimStart();
    const isFunction =
      trimmed.startsWith('async ') || trimmed.startsWith('(') || trimmed.startsWith('function');
    let source: string;
    if (isFunction) {
      source = `(${expr})(${JSON.stringify(arg ?? null)})`;
    } else if (expr.includes(';')) {
      source = `(() => { ${expr} })()`;            // statement list
    } else {
      source = `(${expr})`;                        // plain expression
    }
    return win!.webContents.executeJavaScript(source, true).catch((err: unknown) => {
      throw new Error(`js() failed for ${expr.trim().slice(0, 70)}: ${String(err)}`);
    });
  };

  // "drag": exercise the renderer's real drag path through its test hook.
  // Synthesised DOM events are unreliable (the sandboxed renderer runs
  // executeJavaScript in a world whose events never reach the page listeners).
  if (TEST_PROBE === 'drag') {
    // the renderer's drag API takes SCREEN coordinates, and the pet's world
    // position is what the diagnostic reports
    const spriteH = SPRITE_NATIVE.h * store.all().scale;
    const from = { x: diag.pos.x, y: diag.pos.y - Math.round(spriteH / 2) };
    const to = { x: diag.pos.x - 120, y: diag.pos.y - 150 };
    const sent = (await js(`(() => {
      const t = window.__petTest;
      if (!t) return { hook: false };
      const before = t.info().pet;
      const hitAtFrom = t.hitTest(${from.x}, ${from.y});
      const started = t.beginDrag(${from.x}, ${from.y});
      t.updateDrag(${to.x}, ${to.y});
      t.updateDrag(${to.x + 8}, ${to.y + 8});
      const during = t.info().pet;
      t.finishDrag();
      return { hook: true, hitAtFrom, started, before, during, expectedX: ${to.x + 8} };
    })`)) as {
      hook?: boolean; hitAtFrom?: boolean; started?: boolean;
      before?: { x: number; y: number }; during?: { x: number; y: number };
      expectedX?: number;
    };
    console.log('[probe] drag call:', JSON.stringify(sent));
    const dx = Math.round((sent.during?.x ?? 0) - (sent.before?.x ?? 0));
    const dy = Math.round((sent.during?.y ?? 0) - (sent.before?.y ?? 0));
    return {
      drag: {
        hook: sent.hook === true,
        hitAtFrom: sent.hitAtFrom === true,
        started: sent.started === true,
        moved: Math.abs(dx) > 10 || Math.abs(dy) > 10,
        // the pet must land where it was dropped, in SCREEN space
        landedAt: sent.during ? Math.abs(sent.during.x - (sent.expectedX ?? 0)) < 20 : false,
        dx,
        dy,
      },
    };
  }

  // "window": the window must track the pet and just contain it. This is what
  // makes clicks land on the cat without any click-through machinery.
  if (TEST_PROBE === 'window') {
    const bounds = win!.getBounds();
    const s = spriteSize(store.all().scale);
    return {
      windowCheck: {
        bounds,
        sprite: s,
        pads: {
          left: Math.round(bounds.width - s.w),
          top: Math.round(bounds.height - s.h),
        },
        // window should be sprite + 2*PAD with a small tolerance
        sizedRight:
          Math.abs(bounds.width - (s.w + WINDOW_PAD * 2)) <= 1 &&
          Math.abs(bounds.height - (s.h + WINDOW_PAD * 2)) <= 1,
      },
    };
  }

  // "smooth": record the window's position over a couple of seconds of motion.
  // A healthy walk/drag produces a monotonic-ish path; twitching shows up as
  // the direction reversing many times.
  if (TEST_PROBE === 'smooth') {
    const samples: number[] = [];
    const ySamples: number[] = [];
    const timer = setInterval(() => {
      const b = win?.getBounds();
      if (b) {
        samples.push(b.x);
        ySamples.push(b.y);
      }
    }, 16);
    // make the pet move for a while, then stop
    await js('window.__petTest && window.__petTest.info()');
    await new Promise((r) => setTimeout(r, 2600));
    clearInterval(timer);

    let flipsX = 0;
    let flipsY = 0;
    let maxStepX = 0;
    let maxStepY = 0;
    let pathX = 0;          // total horizontal distance travelled
    for (let i = 2; i < samples.length; i++) {
      const d1 = samples[i - 1] - samples[i - 2];
      const d2 = samples[i] - samples[i - 1];
      if (d1 !== 0 || d2 !== 0) {
        if (Math.sign(d1) !== 0 && Math.sign(d2) !== 0 && Math.sign(d1) !== Math.sign(d2)) flipsX++;
      }
      maxStepX = Math.max(maxStepX, Math.abs(d2));
      pathX += Math.abs(d2);
    }
    for (let i = 2; i < ySamples.length; i++) {
      const d1 = ySamples[i - 1] - ySamples[i - 2];
      const d2 = ySamples[i] - ySamples[i - 1];
      if (Math.sign(d1) !== 0 && Math.sign(d2) !== 0 && Math.sign(d1) !== Math.sign(d2)) flipsY++;
      maxStepY = Math.max(maxStepY, Math.abs(d2));
    }
    // a little back-and-forth is normal (the pet can turn around); dozens of
    // direction changes per second would be a feedback loop. The step limit
    // allows the dead-zone re-centre, which is a deliberate single jump.
    //
    // roam is allowed a much bigger VERTICAL step on purpose: hopping up to a
    // higher spot moves the cat (and its window) fast for a moment. The signal
    // that matters is direction reversals, not the size of a deliberate hop.
    const roamMode = store.all().mode === 'roam';
    const stepLimitY = roamMode ? 320 : 70;
    return {
      smooth: {
        samples: samples.length,
        firstX: samples[0],
        lastX: samples[samples.length - 1],
        spanX: Math.max(...samples) - Math.min(...samples),
        spanY: Math.max(...ySamples) - Math.min(...ySamples),
        // total distance travelled, not just the displacement: roam legitimately
        // stands still for 0.5-1.6s between destinations, and a rest that lands
        // inside the sample window made spanX read 2px and look like "not moving"
        pathX,
        flipsX,
        flipsY,
        maxStepX,
        maxStepY,
        stepLimitY,
        ok: flipsX <= 8 && flipsY <= 8 && maxStepX <= 70 && maxStepY <= stepLimitY,
      },
    };
  }
  // "dragpath": simulate a continuous drag and record where the pet and the
  // window end up after each step. A feedback loop shows up as the pet moving
  // by much more (or in the opposite direction) than the pointer did.
  if (TEST_PROBE === 'dragpath') {
    const spriteH = SPRITE_NATIVE.h * store.all().scale;
    const res = (await js(`(() => {
      const t = window.__petTest;
      if (!t) return null;
      const halfH = Math.round(${spriteH} / 2);
      // Place the pet in the MIDDLE of the work area first. Two reasons:
      // starting near the right edge made it hit the edge clamp after ~50px, so
      // the "1:1 tracking" assertion failed for the wrong reason; and moving it
      // requires a real drag, because updateDrag() is a no-op unless a drag is
      // in progress.
      t.beginDrag(t.info().pet.x, t.info().pet.y - halfH);
      const placed = t.hitTest(1280, 900 - halfH);
      t.updateDrag(1280, 900);
      t.finishDrag();
      const info0 = t.info();
      const startX = info0.pet.x;
      const startY = info0.pet.y - halfH;
      const started = t.beginDrag(startX, startY);
      const path = [];
      let px = startX;
      let py = startY;
      // 12 steps of 8px to the right, like a slow mouse drag
      for (let i = 0; i < 12; i++) {
        px += 8;
        t.updateDrag(px, py);
        const now = t.info();
        path.push({
          pointer: px,
          petX: Math.round(now.pet.x * 100) / 100,
          localX: Math.round(now.local.x * 100) / 100,
          winX: now.windowRect.x,
        });
      }
      const during = t.info().pet;
      t.finishDrag();
      return { placed, started, startX, path, during, dpr: window.devicePixelRatio };
    })`)) as null | {
      placed: boolean;
      started: boolean;
      startX: number;
      path: Array<{ pointer: number; petX: number; localX: number; winX: number }>;
      during: { x: number; y: number };
      dpr: number;
    };
    if (!res) return { dragPath: { ok: false, reason: 'no test hook' } };

    // the pet should track the pointer 1:1: total pet movement == total pointer movement
    const pointerDelta = res.path[res.path.length - 1].pointer - res.startX;
    const petDelta = res.path[res.path.length - 1].petX - res.startX;
    const winDelta = res.path[res.path.length - 1].winX - res.path[0].winX;
    // and every step should move forward, never backwards
    let backSteps = 0;
    for (let i = 1; i < res.path.length; i++) {
      if (res.path[i].petX < res.path[i - 1].petX - 0.01) backSteps++;
    }
    return {
      dragPath: {
        placed: res.placed,
        started: res.started,
        dpr: res.dpr,
        startX: Math.round(res.startX),
        pointerDelta,
        petDelta,
        winDelta,
        backSteps,
        ok:
          res.started &&
          Math.abs(petDelta - pointerDelta) <= 2 &&
          backSteps === 0,
        path: res.path,
      },
    };
  }

  // "inputreport": snapshot the renderer's input counters. Run it manually while
  // a human (or another process) drives the real cursor; that is the only
  // end-to-end check of Windows' event delivery.
  if (TEST_PROBE === 'inputreport') {
    const read = async () =>
      ((await js('window.__petDiag ?? null')) as (SmokeDiag & { input?: Record<string, number> }) | null)
        ?.input ?? {};
    const before = await read();
    await new Promise((r) => setTimeout(r, 9000));
    const after = await read();
    const petAfter = (await js('(window.__petDiag && window.__petDiag.pos) || null')) as
      | { x: number; y: number }
      | null;
    const petMoved = petAfter ? Math.round(petAfter.x - diag.pos.x) : 0;
    const report = {
      gotDown: (after.down ?? 0) > (before.down ?? 0),
      gotUp: (after.up ?? 0) > (before.up ?? 0),
      gotMove: (after.move ?? 0) > (before.move ?? 0),
      dragStarted: (after.dragStarts ?? 0) > (before.dragStarts ?? 0),
      pats: (after.hit ?? 0) > (before.hit ?? 0),
      petMoved,
      backSteps: 0,
      before,
      after,
    };
    return { inputReport: report };
  }

  // "follow": the pet must chase the cursor anywhere on the desktop, in TWO
  // dimensions. Restricting it to the region its own window covers was one bug
  // (horizontal only); pinning `y` to the ground line was another, so the cat
  // could not be brought down to the bottom of the screen.
  if (TEST_PROBE === 'follow') {
    const area = activeArea();
    const realGet = screen.getCursorScreenPoint.bind(screen);
    const targets = [
      { x: area.x + 220, y: area.y + Math.round(area.height * 0.25), label: 'top left' },
      { x: area.x + area.width - 220, y: area.y + Math.round(area.height * 0.7), label: 'lower right' },
      { x: area.x + Math.round(area.width / 2), y: area.y + Math.round(area.height * 0.2), label: 'top centre' },
    ];
    const legs: Array<Record<string, unknown>> = [];
    // follow aims the sprite's CENTRE at the cursor; info().pet reports the
    // sprite's BOTTOM edge, so compare against the centre
    const halfH = (SPRITE_NATIVE.h * store.all().scale) / 2;

    for (const target of targets) {
      const fake = () => ({ x: target.x, y: target.y });
      (screen as unknown as { getCursorScreenPoint: () => { x: number; y: number } })
        .getCursorScreenPoint = fake;
      // poll until it arrives (or give up). This is generous on purpose: the
      // worst leg is a full diagonal (~2300px at 230px/s) and the harness window
      // is shared with whatever else is running.
      const deadline = Date.now() + 40000;
      let info = { pet: { x: 0, y: 0 } } as { pet: { x: number; y: number } };
      let reached = false;
      let centre = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        info = (await js('window.__petTest.info()')) as { pet: { x: number; y: number } };
        centre = info.pet.y - halfH;
        if (Math.hypot(info.pet.x - target.x, centre - target.y) < 40) {
          reached = true;
          break;
        }
      }
      legs.push({
        label: target.label,
        targetX: target.x,
        targetY: target.y,
        petX: Math.round(info.pet.x),
        petBottomY: Math.round(info.pet.y),
        petCentreY: Math.round(centre),
        error: Math.round(Math.hypot(info.pet.x - target.x, centre - target.y)),
        reached,
      });
    }

    (screen as unknown as { getCursorScreenPoint: () => { x: number; y: number } })
      .getCursorScreenPoint = realGet;

    return {
      followCheck: {
        legs,
        ok: legs.every((l) => l.reached === true),
        windowBounds: win!.getBounds(),
      },
    };
  }

  // "followtrace": pin the fake cursor to ONE place and record what the renderer
  // actually chases. Reading the target back tells us whether the global cursor
  // feed reaches the renderer at all.
  if (TEST_PROBE === 'followtrace') {
    const area = activeArea();
    const realGet = screen.getCursorScreenPoint.bind(screen);
    // PET_TRACE_TARGET='x,y' pins the simulated cursor somewhere specific
    const raw = process.env.PET_TRACE_TARGET ?? '';
    const parts = raw.split(',').map((v) => Number(v.trim()));
    const target =
      parts.length === 2 && parts.every((v) => Number.isFinite(v))
        ? { x: parts[0], y: parts[1] }
        : { x: area.x + 400, y: area.y + area.height - 60 };
    (screen as unknown as { getCursorScreenPoint: () => { x: number; y: number } })
      .getCursorScreenPoint = () => target;
    await js('window.__petTrace = true');
    const samples: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const d = (await js('window.__petDiag ?? null')) as
        | { follow?: unknown; trace?: unknown[]; pos?: unknown }
        | null;
      samples.push({ pos: d?.pos, follow: d?.follow });
    }
    (screen as unknown as { getCursorScreenPoint: () => { x: number; y: number } })
      .getCursorScreenPoint = realGet;
    const last = (await js('window.__petDiag.trace ?? []')) as unknown[];
    return { followTrace: { target, cursorStats, samples, trace: last } };
  }

  // "chase": call the controller's follow step directly and report the delta, so
  // a pinned hover can be told apart from "the loop never calls chase".
  if (TEST_PROBE === 'chase') {
    const res = (await js(`(() => {
      const t = window.__petTest;
      if (!t || !t.stepChase) return null;
      const a = t.stepChase(900, 300, 0.05);
      const b = t.stepChase(900, 300, 0.05);
      return { first: a, second: b, info: t.info() };
    })`)) as unknown;
    return { chaseProbe: res };
  }

  // "domtarget": the canvas must actually be hit-testable. With
  // `pointer-events: none` on it, pointer events never target it and dragging
  // silently stops working -- a CSS regression that logic-level probes miss.
  if (TEST_PROBE === 'domtarget') {
    const res = (await js(`(() => {
      const c = document.getElementById('pet');
      const r = c.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const cs = getComputedStyle(c);
      return {
        canvasRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        pointerEvents: cs.pointerEvents,
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitIsCanvas: hit === c,
        // a dispatched pointerdown on the canvas must bubble to the window
        // listener that starts a drag
        bubbled: (() => {
          let seen = false;
          const probe = () => { seen = true; };
          window.addEventListener('pointerdown', probe);
          c.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
          }));
          window.removeEventListener('pointerdown', probe);
          return seen;
        })(),
      };
    })`)) as {
      canvasRect: { x: number; y: number; w: number; h: number };
      pointerEvents: string;
      hitTag: string | null;
      hitIsCanvas: boolean;
      bubbled: boolean;
    };
    return {
      domTarget: {
        ...res,
        ok: res.hitIsCanvas && res.bubbled && res.pointerEvents !== 'none',
      },
    };
  }

  // "dragprobe": drive the REAL pointer path (pointerdown/move/up on the DOM),
  // not the renderer's test hook. The hook only proves the drag maths; it says
  // nothing about whether events reach the page, whether the grab offset is
  // right, or whether the drag survives the pointer leaving the small window --
  // which is exactly how "long-press and move the cat" broke.
  if (TEST_PROBE === 'dragprobe') {
    const halfH = Math.round((SPRITE_NATIVE.h * store.all().scale) / 2);
    const res = (await js(`(async (P) => {
      const t = window.__petTest;
      if (!t) return { hook: false };
      const r0 = t.info().windowRect;
      // screen -> client coordinates, exactly what a real pointer event carries
      const ev = (type, sx, sy, buttons, button) => {
        const r = t.info().windowRect;
        window.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
          isPrimary: true, button: button, buttons: buttons,
          clientX: sx - r.x, clientY: sy - r.y,
        }));
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

      // Park the cat inside the legal band with a real drag, grabbing it by the
      // head (the mask rejects points that are not solidly on the cat -- the
      // bottom-centre of a sitting cat is tail/background, so that grab failed).
      const parkY = P.area.y + Math.round((P.area.height - P.spriteH) / 2);
      const x0 = t.info().pet;
      // drag 1: pull it left, well clear of the right-hand clamp (a +150px leg
      // would otherwise hit the wall at 2446 and be clamped)
      t.beginDrag(x0.x, x0.y - P.halfH);
      t.updateDrag(x0.x - 600, x0.y);
      t.finishDrag();
      await frame();
      // drag 2: grab it again and raise it to the middle of the legal band
      const x1 = t.info().pet;
      const grabA = { x: x1.x, y: x1.y - P.halfH };
      const startedA = t.beginDrag(grabA.x, grabA.y);
      t.updateDrag(x1.x, parkY);
      t.finishDrag();
      await frame();
      await frame();
      const mid = t.info().pet;
      const down = { x: mid.x, y: mid.y - P.halfH };
      const hitAtStart = t.hitTest(down.x, down.y);
      const startedB = t.beginDrag(down.x, down.y);
      const info0 = t.info();
      const parked = { x: info0.pet.x, y: info0.pet.y };

      // leg 1 doubles as the "grab point preserved" check: the offset taken at
      // pointerdown must put the cat exactly where the pointer went
      const p1 = { x: down.x - 300, y: down.y + 60 };
      const expect1 = { x: parked.x - 300, y: parked.y + 60 };
      const p2 = { x: down.x - 160, y: down.y - 90 };
      const p3 = { x: down.x + 150, y: down.y + 30 };
      const expect3 = { x: parked.x + 150, y: parked.y + 30 };
      ev('pointerdown', down.x, down.y, 1, 0);
      const afterDown = t.info();

      // Each leg reports the renderer's window rect AND asks the main process for
      // the real window bounds in the same turn, so "how far behind is the window"
      // is measured at one instant. Comparing samples taken at different moments
      // just measures how far the pet travelled, not the lag.
      const leg = async (x, y) => {
        ev('pointermove', x, y, 1, -1);
        await frame();
        await frame();
        // synchronous, so the real bounds and the renderer's idea of them describe
        // the SAME instant
        const r = window.pet.realBounds();
        const rendered = t.info().windowRect;
        const lag = r ? Math.round(Math.hypot(r.x - rendered.x, r.y - rendered.y)) : -1;
        return { lag, info: t.info() };
      };
      const farLeg = await leg(p1.x, p1.y);
      const afterFar = farLeg.info;
      const midLeg = await leg(p2.x, p2.y);
      const afterMid = midLeg.info;
      const thirdLeg = await leg(p3.x, p3.y);
      const afterThird = thirdLeg.info;
      const lagSamples = [farLeg.lag, midLeg.lag, thirdLeg.lag];

      // release with NO pointerup delivered: the render-loop watchdog must end
      // the drag, otherwise the pet goes deaf until it restarts
      const stuckAfterRelease = await new Promise((r) => setTimeout(() => r(t.info().dragging), 1900));
      const afterWatchdog = t.info();
      ev('pointerup', p2.x, p2.y, 0, 0);
      await frame();
      const afterUp = t.info();

      // a small press must still count as a pat, not a drag
      const click = { x: afterUp.pet.x, y: afterUp.pet.y - P.halfH };
      ev('pointerdown', click.x, click.y, 1, 0);
      ev('pointerup', click.x + 2, click.y + 2, 0, 0);
      const afterClick = t.info();

      return {
        hook: true, hitAtStart, down, p1, p2, p3, park: parked, expect3, win0: r0,
        lagSamples,
        parkSteps: { startedA, grabA, startedB, mid },
        afterDown: { dragging: afterDown.dragging, offset: afterDown.offset },
        afterFar: { dragging: afterFar.dragging, pet: afterFar.pet, facing: afterFar.facing },
        afterMid: { dragging: afterMid.dragging, pet: afterMid.pet, facing: afterMid.facing },
        afterThird: { dragging: afterThird.dragging, pet: afterThird.pet, facing: afterThird.facing },
        stuckAfterRelease,
        afterWatchdog: { dragging: afterWatchdog.dragging, pet: afterWatchdog.pet },
        afterUp: { dragging: afterUp.dragging, pet: afterUp.pet },
        afterClick: { stats: afterClick.stats },
      };
    })`, {
      halfH,
      park: { x: 2400, y: 900 },
      area: activeArea(),
      spriteH: SPRITE_NATIVE.h * store.all().scale,
    })) as null | Record<string, unknown>;

    if (!res) return { dragProbe: { ok: false, reason: 'no test hook' } };
    const far = (res.afterFar ?? {}) as { pet?: { x: number; y: number } };
    const mid = (res.afterMid ?? {}) as { pet?: { x: number; y: number } };
    const third = (res.afterThird ?? {}) as { pet?: { x: number; y: number } };
    const up = (res.afterUp ?? {}) as { pet?: { x: number; y: number } };
    const p1 = res.p1 as { x: number; y: number };
    const p2 = res.p2 as { x: number; y: number };
    const down = res.down as { x: number; y: number };
    const park = res.park as { x: number; y: number };
    /**
     * The grab offset is taken once, at mouse-down, so after the pointer has
     * moved by (to - down) the cat must sit exactly there.
     *
     * Comparing the pet's world position with the pointer's SCREEN position
     * instead is what made an earlier version of this probe report a phantom
     * 102px error: the window moves to follow the cat, so the same screen point
     * is a different world point once the window has moved.
     */
    const errAt = (got: { x: number; y: number } | undefined, to: { x: number; y: number }) => {
      if (!got) return -1;
      const wantX = park.x + (to.x - down.x);
      const wantY = park.y + (to.y - down.y);
      return Math.round(Math.hypot(got.x - wantX, got.y - wantY));
    };
    const near = (d: number) => d >= 0 && d < 8;
    const errFirst = errAt(far.pet, p1);
    const errSecond = errAt(mid.pet, p2);
    // the third leg is asserted in ABSOLUTE terms, so a wrong grab offset cannot
    // be cancelled out by a matching baseline
    const expect3 = res.expect3 as { x: number; y: number };
    const errThird = third.pet
      ? Math.round(Math.hypot(third.pet.x - expect3.x, third.pet.y - expect3.y))
      : -1;
    const stuck = res.stuckAfterRelease as boolean;
    const lagSamples = (res.lagSamples as number[] | undefined) ?? [];
    const dragWindowDrift = lagSamples.length ? Math.max(...lagSamples) : -1;
    const droppedAtY = (res.afterWatchdog as { pet?: { y: number } })?.pet?.y ?? 0;
    const finalY = up.pet ? up.pet.y : 0;
    return {
      dragProbe: {
        ...res,
        errFirstMove: errFirst,
        errSecondMove: errSecond,
        errThirdMove: errThird,
        dropToGroundBy: Math.round(finalY - droppedAtY),
        gotToFirstMove: near(errFirst),
        gotToSecondMove: near(errSecond),
        gotToThirdMove: near(errThird),
        releasedCleanly: (res.afterWatchdog as { dragging?: boolean })?.dragging === false,
        pettedAfter: ((res.afterClick as { stats?: { hit?: number } })?.stats?.hit ?? 0) > 0,
        // The cat must LOOK the way it is being pulled: leg 1 drags left, leg 2
        // right, leg 3 right again. `facing` is the value the renderer uses to
        // mirror the artwork, and the artwork faces left, so -1 must mean left.
        // (The mirroring itself is verified against the art in
        // tools/check_facing_metric.py: mirroring moves the row profile by 34.)
        facingFar: (far as { facing?: number })?.facing ?? null,
        facingMid: (mid as { facing?: number })?.facing ?? null,
        facingThird: (third as { facing?: number })?.facing ?? null,
        // the window must track the cat WHILE dragging: a gap means the dead zone
        // or the report throttle is still applied, i.e. the pet lags the pointer
        dragWindowDrift,
        facingFollowsDrag:
          (far as { facing?: number })?.facing === -1 &&
          (mid as { facing?: number })?.facing === 1 &&
          (third as { facing?: number })?.facing === 1,
        // 1:1 tracking past the window edge in all three directions, no stuck
        // drag, the watchdog let go on its own, and the cat faces where it goes
        ok:
          res.hitAtStart === true &&
          near(errFirst) &&
          near(errSecond) &&
          near(errThird) &&
          stuck === false &&
          (res.afterWatchdog as { dragging?: boolean })?.dragging === false &&
          (far as { facing?: number })?.facing === -1 &&
          (mid as { facing?: number })?.facing === 1,
      },
    };
  }

  // "roam": free movement must use the WHOLE work area, not just the bottom
  // strip. Buckets the pet's height over time and reports how many vertical
  // slices of the screen it visited -- the old bottom-only wander scored 1.
  if (TEST_PROBE === 'roam') {
    await js('window.__petTrace = true');
    // 50ms samples plus the renderer's own per-frame trace: a 250ms poll can
    // easily miss every apex of a hop, which makes a climbing pet look static
    const samples: Array<{ y: number; x: number; g: boolean }> = [];
    const deadline = Date.now() + 34000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const d = (await js('window.__petDiag ?? null')) as
        | { pos?: { x: number; y: number; ground: boolean } }
        | null;
      if (d?.pos) samples.push({ y: d.pos.y, x: d.pos.x, g: d.pos.ground });
    }
    const ys = samples.map((s) => s.y);
    const area = activeArea();
    const spriteH = SPRITE_NATIVE.h * store.all().scale;
    const top = area.y + spriteH;      // highest legal bottom edge
    const ground = area.y + area.height;
    const mid = (top + ground) / 2;
    const bucket = 150;                // px per slice, roughly one hop
    const slices = new Set<number>(ys.map((y) => Math.floor((y - top) / bucket)));
    const usedTop = Math.min(...ys);
    const usedBottom = Math.max(...ys);
    const upperHalf = ys.some((y) => y < mid);
    // how long the cat actually spent off the floor, not just a single sample
    const offFloor = ys.filter((y) => y < ground - 150).length;
    // biggest single-sample vertical move: roam is a straight-line walk now, so a
    // spike here would mean something is still launching the cat
    let maxStepY = 0;
    for (let i = 1; i < ys.length; i++) maxStepY = Math.max(maxStepY, Math.abs(ys[i] - ys[i - 1]));
    return {
      roamCheck: {
        samples: ys.length,
        legalTop: Math.round(top),
        legalBottom: Math.round(ground),
        usedTop: Math.round(usedTop),
        usedBottom: Math.round(usedBottom),
        slicesVisited: slices.size,
        slicesAvailable: Math.ceil((ground - top) / bucket),
        upperHalfVisited: upperHalf,
        offFloorSamples: offFloor,
        maxStepY,
        coverage: Math.round(((usedBottom - usedTop) / (ground - top)) * 100) / 100,
        leftGroundBy: Math.round(ground - usedTop),
        // A bottom-strip wander scores 1-2 slices and never spends time up high.
        // Real 2D roaming scores 4+ slices, spends real time off the floor, and
        // covers most of the height.
        ok: slices.size >= 4 && offFloor > 20 && ground - usedTop > 400,
      },
    };
  }

  // "speed": the roam-speed preset must actually change how fast the cat moves.
  // Reads the renderer's measured per-frame speed (max over the run, so a rest
  // pause does not drag the number down) rather than timing a wall-clock walk,
  // which keeps it short and deterministic.
  if (TEST_PROBE === 'speed') {
    const samples: number[] = [];
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const d = (await js('window.__petDiag ?? null')) as { speed?: number } | null;
      if (typeof d?.speed === 'number') samples.push(d.speed);
    }
    const peak = samples.length ? Math.max(...samples) : 0;
    return { speedCheck: { samples: samples.length, peakSpeed: peak, preset: store.all().roamSpeed } };
  }

  // "watchinput": report the renderer's pointer counters + pet position while a
  // HUMAN drives the mouse. Synthetic DOM events proved the drag math, but they
  // cannot prove that a real button press reaches the page, which is the one
  // thing left that only real input can show.
  if (TEST_PROBE === 'watchinput') {
    const seconds = Number(process.env.PET_WATCH_SECONDS ?? 25) || 25;
    console.log('[watch] please press and drag the cat now; logging every 500ms for', seconds, 's');
    const deadline = Date.now() + seconds * 1000;
    let last = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const d = (await js('window.__petDiag ?? null')) as
        | {
            pos?: { x: number; y: number };
            input?: Record<string, number | boolean | string>;
            windowRect?: { x: number; y: number };
            follow?: { cursor?: { x: number; y: number } };
          }
        | null;
      if (!d?.input) continue;
      const line = JSON.stringify({
        down: d.input.down,
        move: d.input.move,
        up: d.input.up,
        hit: d.input.hit,
        dragStarts: d.input.dragStarts,
        cancel: d.input.cancel,
        pos: d.pos,
        win: d.windowRect,
        cursor: d.follow?.cursor,
      });
      if (line !== last) {
        console.log('[watch]', line);
        last = line;
      }
    }
    console.log('[watch] done');
    return { watchInput: 'see log' };
  }

  // "stale": compare the window rectangle the RENDERER believes in against the
  // window's real bounds. Input handling converts pointer client coordinates to
  // screen coordinates with that cached rectangle, so if it lags behind a moving
  // window every hit test is off by the lag -- which would make the cat
  // "undraggable" exactly while it is walking around.
  if (TEST_PROBE === 'stale') {
    // Attach the renderer's per-frame tracing so diagnostics are published every
    // frame: without it they are snapshots up to 250ms old, which made an earlier
    // version of this probe report a drift that no longer existed.
    await js('window.__petTrace = true');
    const rows: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const d = (await js('window.__petDiag ?? null')) as
        | {
            windowRect?: { x: number; y: number };
            pos?: { x: number; y: number };
            windowMoved?: { count: number; last: { x: number; y: number } };
          }
        | null;
      const real = win?.getBounds();
      if (!d?.windowRect || !real) continue;
      rows.push({
        renderer: { x: d.windowRect.x, y: d.windowRect.y },
        real: { x: real.x, y: real.y },
        dx: d.windowRect.x - real.x,
        dy: d.windowRect.y - real.y,
        moved: d.windowMoved,
        moveStats: { ...moveStats },
        pet: d.pos,
      });
    }
    const maxDx = Math.max(...rows.map((r) => Math.abs(Number(r.dx))));
    const maxDy = Math.max(...rows.map((r) => Math.abs(Number(r.dy))));
    // A drift of a frame or two is unavoidable (the window and the notification
    // are not atomic). Hundreds of pixels means the renderer is not being told
    // about moves at all, which is what made the cat ungrabbable.
    const ok = maxDx <= 60 && maxDy <= 60;
    return {
      staleCheck: {
        samples: rows.length,
        maxDriftX: maxDx,
        maxDriftY: maxDy,
        limit: 60,
        ok,
        worst: rows.slice().sort((a, b) => Math.abs(Number(b.dy)) - Math.abs(Number(a.dy)))[0],
        sample: rows.slice(0, 6),
      },
    };
  }

  // "carry": dragging must hold the carried pose for the WHOLE drag, then let it
  // go. As a transient the pose expired after ~0.3s and the cat sat down while
  // still being carried.
  if (TEST_PROBE === 'carry') {
    // Read the animator LIVE. window.__petDiag is only published every 250ms and
    // only while a probe is attached, so a snapshot taken during a drag describes
    // a moment that may already be gone -- which made this probe report "no pose"
    // while the transition history showed the pose was held the whole time.
    const diag = async () =>
      (await js(`(() => {
        const s = window.__petTest.animState();
        return { active: s.channel, override: s.override, persistent: s.persistent, dragging: s.dragging };
      })`)) as { active: string; override: string | null; persistent: boolean; dragging: boolean } | null;
    const idle = await diag();
    // Keep feeding move events while the drag is held: without them the 1.5s
    // watchdog (correctly) ends the drag and releases the pose.
    await js(`(async (P) => {
      const t = window.__petTest;
      const info = t.info();
      const grab = { x: info.pet.x, y: info.pet.y - P.halfH };
      window.__carryStarted = t.beginDrag(grab.x, grab.y);
      let i = 0;
      window.__carryTimer = setInterval(() => {
        i += 1;
        t.updateDrag(grab.x + 12 * i, grab.y - 6 * i);
      }, 300);
      t.updateDrag(grab.x + 60, grab.y - 120);
      return window.__carryStarted;
    })`, { halfH: Math.round((SPRITE_NATIVE.h * store.all().scale) / 2) });
    // well past the length of the animation itself (6 frames @ 3.4fps ≈ 1.8s)
    await new Promise((r) => setTimeout(r, 2600));
    const held = await diag();
    await js('clearInterval(window.__carryTimer); window.__petTest.finishDrag();');
    // diagnostics are published every 250ms, so leave room for a fresh snapshot
    await new Promise((r) => setTimeout(r, 600));
    const released = await diag();
    const started = (await js('window.__carryStarted === true')) as boolean;
    const animState = (await js('window.__petTest.animState()')) as unknown;
    return {
      carryCheck: {
        started,
        idle,
        held,
        released,
        animState,
        // the pose must still be up 2.6s into the drag, and gone after release
        ok:
          started === true &&
          held?.override === 'carry' &&
          held.persistent === true &&
          released?.override !== 'carry',
      },
    };
  }

  // "hitgrid": sweep the hit test across the whole window and report the screen
  // rectangle where it says "yes". Direct way to catch an offset between the
  // drawn cat and the clickable area.
  if (TEST_PROBE === 'hitgrid') {
    const bounds = win!.getBounds();
    const res = (await js(`(() => {
      const t = window.__petTest;
      if (!t) return null;
      const info = t.info();
      const w = info.windowRect.width;
      const h = info.windowRect.height;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hits = 0, total = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          total++;
          // hitTest takes SCREEN coordinates
          if (t.hitTest(x + info.windowRect.x, y + info.windowRect.y)) {
            hits++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return {
        windowRect: info.windowRect,
        pet: info.pet,
        local: info.local,
        pad: ${WINDOW_PAD},
        sprite: { w: ${SPRITE_NATIVE.w} * info.pet.scale, h: ${SPRITE_NATIVE.h} * info.pet.scale },
        sampled: total,
        hits,
        hitRectLocal: hits ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
      };
    })`)) as null | {
      windowRect: Rectangle;
      pet: { x: number; y: number; scale: number };
      local: { x: number; y: number };
      pad: number;
      sprite: { w: number; h: number };
      sampled: number;
      hits: number;
      hitRectLocal: { x: number; y: number; w: number; h: number } | null;
    };
    if (!res) return { hitGrid: { ok: false, reason: 'no test hook' } };

    // where the cat is actually drawn, in screen coordinates
    const drawnScreen = {
      x: Math.round(bounds.x + res.local.x - res.sprite.w / 2 + res.pad),
      y: Math.round(bounds.y + res.local.y - res.sprite.h + res.pad),
      w: res.sprite.w,
      h: res.sprite.h,
    };
    const hitScreen = res.hitRectLocal
      ? {
          x: bounds.x + res.hitRectLocal.x,
          y: bounds.y + res.hitRectLocal.y,
          w: res.hitRectLocal.w,
          h: res.hitRectLocal.h,
        }
      : null;

    const ok =
      !!hitScreen &&
      Math.abs(hitScreen.x - drawnScreen.x) <= 12 &&
      Math.abs(hitScreen.y - drawnScreen.y) <= 12 &&
      Math.abs(hitScreen.w - drawnScreen.w) <= 16 &&
      Math.abs(hitScreen.h - drawnScreen.h) <= 16;

    return {
      hitGrid: {
        ok,
        windowBounds: bounds,
        drawnScreen,
        hitScreen,
        delta: hitScreen
          ? { x: hitScreen.x - drawnScreen.x, y: hitScreen.y - drawnScreen.y }
          : null,
        hits: res.hits,
        sampled: res.sampled,
      },
    };
  }
  // "hittest": the pixel hit test must accept the cat's centre and reject the
  // transparent padding.
  if (TEST_PROBE === 'hittest') {
    const halfH = Math.round((SPRITE_NATIVE.h * store.all().scale) / 2);
    const res = (await js(`(() => {
      const t = window.__petTest;
      if (!t) return null;
      const pad = ${WINDOW_PAD};
      const info = t.info();
      // screen coordinates of the sprite's centre
      const centre = { x: Math.round(info.pet.x), y: Math.round(info.pet.y - ${halfH}) };
      const probe = (x, y) => ({ x, y, hit: t.hitTest(x, y) });
      return {
        pad, centre,
        centreProbe: probe(centre.x, centre.y),
        paddingProbe: probe(info.windowRect.x + 1, info.windowRect.y + 1),
      };
    })`)) as null | {
      pad: number;
      centre: { x: number; y: number };
      centreProbe: { hit: boolean };
      paddingProbe: { hit: boolean };
    };
    return {
      hitCheck: {
        ...res,
        ok: !!res && res.centreProbe.hit === true && res.paddingProbe.hit === false,
      },
    };
  }

  return { probe: TEST_PROBE };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) createWindow();
    win?.showInactive();
    win?.webContents.send('pet:pat');
  });

  app.on('will-quit', () => {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
  });

  app.whenReady().then(() => {
    store.load();
    if (SMOKE_MS > 0) {
      // A smoke run must be reproducible and must not leave traces: ignore what
      // is on disk, apply any forced config, and never write anything back.
      store.setReadOnly(true);
      store.reset(TEST_CONFIG);
      console.log('[main] smoke run: config reset to defaults', JSON.stringify(TEST_CONFIG));
    }
    applyAutostart(store.all().autostart);
    registerIpc();
    createWindow();
    createTray();

    screen.on('display-metrics-changed', () => win?.webContents.send('pet:frame', frameInfo()));
    screen.on('display-added', () => win?.webContents.send('pet:frame', frameInfo()));
    screen.on('display-removed', () => win?.webContents.send('pet:frame', frameInfo()));
  });

  app.on('before-quit', () => store.saveNow());

  app.on('window-all-closed', () => {
    // the pet has no taskbar entry: closing every window means "quit"
    app.quit();
  });
}
