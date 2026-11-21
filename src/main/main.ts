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
  powerMonitor,
  screen,
  type Point,
  type Rectangle,
} from 'electron';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigStore, type PetConfig, type PetMode, type PetScale, type RoamSpeed } from './config';

const APP_DIR = app.getAppPath();
const IS_PACKED = app.isPackaged;
const RENDERER_HTML = join(APP_DIR, 'dist', 'renderer', 'renderer', 'index.html');

// Keep the userData directory identical between `electron .` and the packaged
// exe, otherwise dev runs and installed runs would keep separate configs (and
// leave a stray %APPDATA%\desktop-pet behind).
app.setName('CalicoPet');

// Chromium's --user-data-dir does not override app.getPath('userData') after a
// custom app name is set, so the regression scripts need an explicit override.
// This is test-only: normal launches never set the variable and keep using
// %APPDATA%\CalicoPet.
const TEST_USER_DATA_DIR = process.env.PET_USER_DATA_DIR;
if (TEST_USER_DATA_DIR) app.setPath('userData', TEST_USER_DATA_DIR);

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
let latestShape: Rectangle[] = [];
let shapeVersion = 0;
const shapeStats = { updates: 0, errors: 0, rectangles: 0 };
let rendererRecoveryAttempts = 0;
let lastRendererRecoveryAt = 0;
let smokeStarted = false;
let quitting = false;
/** display used when config.displayId is null (automatic mode) */
let autoDisplayId: number | null = null;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function activeDisplay(): Electron.Display {
  const cfg = store.all();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  let display: Electron.Display | undefined;
  if (cfg.displayId != null) {
    display = displays.find((d) => d.id === cfg.displayId);
  } else {
    if (autoDisplayId != null) display = displays.find((d) => d.id === autoDisplayId);
    if (!display && cfg.x != null && cfg.y != null) {
      display = screen.getDisplayNearestPoint({ x: cfg.x, y: cfg.y });
    }
    if (!display && win) display = screen.getDisplayMatching(win.getContentBounds());
  }
  // A removed display (or one stale saved id) must never leave the pet off-screen.
  display ??= primary;
  autoDisplayId = display.id;
  return display;
}

function activeArea(): Rectangle {
  return activeDisplay().workArea;
}

function clampAnchorToArea(anchorX: number, anchorY: number, area: Rectangle, scale: PetScale): Point {
  const s = spriteSize(scale);
  return {
    x: Math.min(Math.max(anchorX, area.x + s.w / 2), area.x + area.width - s.w / 2),
    y: Math.min(Math.max(anchorY, area.y + s.h), area.y + area.height),
  };
}

/** automatic mode follows the cursor only for follow/drag, never for idle roam */
function setAutoDisplayFromPoint(point: Point): void {
  if (store.all().displayId != null) return;
  const display = screen.getDisplayNearestPoint(point);
  if (display.id === autoDisplayId) return;
  autoDisplayId = display.id;
  win?.webContents.send('pet:frame', frameInfo());
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
 * walks or is dragged. Windows can retain an invisible, DPI-dependent outer
 * frame even for a frameless transparent window, so all coordinates in the
 * renderer contract are CONTENT bounds rather than outer-window bounds.
 *
 * Every report carries a sequence number. The renderer draws against the newest
 * target immediately and ignores older native echoes; this keeps the sprite at a
 * stable local anchor instead of letting an old echo pull it sideways for one
 * frame (the visible "ghost"/twitch during fast roam and drag).
 */
function moveWindowToAnchor(anchorX: number, anchorY: number, seq = 0): void {
  if (!win) return;
  moveStats.requested++;
  const scale = store.all().scale;
  const s = spriteSize(scale);
  const { w, h } = windowSize(scale);
  const anchor = clampAnchorToArea(anchorX, anchorY, activeArea(), scale);
  const x = Math.round(anchor.x - WINDOW_PAD - s.w / 2);
  const y = Math.round(anchor.y - WINDOW_PAD - s.h);
  if (x !== windowOrigin.x || y !== windowOrigin.y) {
    // Windows adds a DPI-dependent invisible frame even to some frameless
    // windows. setPosition() addresses that outer frame; the renderer draws in
    // CONTENT coordinates. Address the content rectangle directly so 150%/175%
    // scaling cannot introduce a few pixels of relative sprite/window motion.
    win.setContentBounds({ x, y, width: w, height: h });
    moveStats.sent++;
  } else {
    moveStats.deduped++;
  }
  const actual = win.getContentBounds();
  windowOrigin = { x: actual.x, y: actual.y };
  // The sequence lets the renderer discard an echo for an older pet position.
  moveStats.last = { x: actual.x, y: actual.y };
  win.webContents.send('pet:windowMoved', {
    x: actual.x,
    y: actual.y,
    width: actual.width,
    height: actual.height,
    seq,
  });
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
    backgroundColor: '#00000000',
    frame: false,
    roundedCorners: false,
    thickFrame: false,
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

  win.setContentSize(w, h);
  win.setContentBounds({ x, y, width: w, height: h });
  windowOrigin = { x: win.getContentBounds().x, y: win.getContentBounds().y };
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
      const b = win.getContentBounds();
      windowOrigin = { x: b.x, y: b.y };
    }
  });

  if (!existsSync(RENDERER_HTML)) {
    console.error('[main] renderer bundle missing at', RENDERER_HTML);
  }

  // The pet is a local, offline surface. It never opens child windows or
  // navigates away, so deny both instead of relying on the CSP alone.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) {
      console.error('[main] blocked renderer navigation:', url);
      event.preventDefault();
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[main] renderer load failed (${code} ${description}): ${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    refreshPowerSaving();
    if (!activityActive) win?.webContents.send('pet:activity', false);
  });
  void win.loadFile(RENDERER_HTML).catch((err) => {
    console.error('[main] failed to load renderer:', err);
  });

  if (process.env.PET_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', details.reason);
    if (quitting || details.reason === 'clean-exit') return;
    if (SMOKE_MS > 0 && TEST_PROBE !== 'recovery') return;
    const now = Date.now();
    if (now - lastRendererRecoveryAt > 60000) rendererRecoveryAttempts = 0;
    if (rendererRecoveryAttempts >= 2) {
      console.error('[main] renderer recovery paused after repeated failures');
      return;
    }
    rendererRecoveryAttempts++;
    lastRendererRecoveryAt = now;
    const delay = rendererRecoveryAttempts * 750;
    console.warn(`[main] recovering renderer in ${delay}ms (attempt ${rendererRecoveryAttempts})`);
    setTimeout(() => {
      if (!quitting && win && !win.isDestroyed()) win.webContents.reload();
    }, delay);
  });

  win.webContents.on('unresponsive', () => console.warn('[main] renderer became unresponsive'));
  win.webContents.on('responsive', () => console.log('[main] renderer responsive again'));

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
    if (SMOKE_MS > 0 && !smokeStarted) {
      smokeStarted = true;
      startSmokeRun();
    }
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
    activityActive,
    powerSaving,
    /** test hooks are installed only for automated runs, never in normal use */
    testMode: SMOKE_MS > 0 || TEST_PROBE.length > 0,
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function patch(part: Partial<PetConfig>): PetConfig {
  const previous = store.all();
  const next = store.patch(part);
  applyConfig(previous, next, part);
  return next;
}

function applyConfig(previous: PetConfig, cfg: PetConfig, part: Partial<PetConfig>): void {
  // Persisting the pet's position happens after every drag. It must not resize
  // the native window, rebuild the tray menu, or bounce a config copy through
  // IPC: those are UI changes, not position changes.
  const keys = Object.keys(part);
  const positionOnly = keys.length > 0 && keys.every((key) => key === 'x' || key === 'y' || key === 'facing');
  if (positionOnly) return;

  if (win) {
    if (previous.alwaysOnTop !== cfg.alwaysOnTop) {
      win.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
    }
    if (previous.scale !== cfg.scale) {
      const { w, h } = windowSize(cfg.scale);
      const b = win.getContentBounds();
      win.setContentBounds({ x: b.x, y: b.y, width: w, height: h });
      // The old native region must not clip the resized frame while the renderer
      // builds its new mask. The next pet:setShape message replaces this rectangle.
      win.setShape([{ x: 0, y: 0, width: w, height: h }]);
      latestShape = [];
    }
    win.webContents.send('config:changed', { ...cfg });
    if (previous.displayId !== cfg.displayId && cfg.displayId != null) {
      const home = homeAnchor(activeArea(), cfg.scale);
      moveWindowToAnchor(home.x, home.y);
      win.webContents.send('pet:recenter', frameInfo());
    }
  }
  tray?.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  // Idempotent, and only relevant when mode or paused changed; keeping the call
  // unconditional here avoids duplicating the eligibility rules in two places.
  syncCursorPolling();
  refreshPowerSaving();
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
const moveStats = { requested: 0, sent: 0, deduped: 0, last: { x: 0, y: 0 } };

function pushCursor(): void {
  cursorStats.polls++;
  if (!win || win.isDestroyed()) {
    cursorStats.skipped++;
    return;
  }
  const p = screen.getCursorScreenPoint();
  setAutoDisplayFromPoint(p);
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
  const needs = cfg.mode === 'follow' && !cfg.paused && activityActive;
  if (needs && !cursorTimer) {
    cursorTimer = setInterval(pushCursor, 40);
    pushCursor();
  } else if (!needs && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
    lastCursorSent = { x: NaN, y: NaN };
  }
}

// Background activity is separate from the user's persisted pause setting. A
// hidden/locked/sleeping desktop must stop timers without changing cfg.paused.
let manuallyHidden = false;
let screenLocked = false;
let systemSuspended = false;
let activityActive = true;
let powerSaving = false;

function syncActivity(): void {
  const next = !manuallyHidden && !screenLocked && !systemSuspended;
  if (next === activityActive) return;
  activityActive = next;
  if (win && !win.isDestroyed()) win.webContents.send('pet:activity', next);
  syncCursorPolling();
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function togglePetVisibility(): void {
  manuallyHidden = !manuallyHidden;
  syncActivity();
  if (manuallyHidden) win?.hide();
  else win?.showInactive();
  refreshTrayMenu();
}

function applyPowerSaving(enabled: boolean): void {
  if (enabled === powerSaving) return;
  powerSaving = enabled;
  if (win && !win.isDestroyed()) win.webContents.send('pet:powerSaving', enabled);
}

function refreshPowerSaving(): void {
  applyPowerSaving(store.all().batterySaver && powerMonitor.isOnBatteryPower());
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
    { label: manuallyHidden ? '显示桌宠' : '隐藏桌宠', click: () => togglePetVisibility() },
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
    {
      label: '使用电池时降低更新频率',
      type: 'checkbox',
      checked: cfg.batterySaver,
      click: (item) => patch({ batterySaver: item.checked }),
    },
    { type: 'separator' },
    {
      label: '显示器',
      submenu: [
        {
          label: '自动（当前活动屏）',
          type: 'radio' as const,
          checked: cfg.displayId == null,
          click: () => patch({ displayId: null }),
        },
        ...screen.getAllDisplays().map((display, index) => ({
          label: `显示器 ${index + 1}${display.id === screen.getPrimaryDisplay().id ? '（主）' : ''} · ${display.workArea.width}×${display.workArea.height}`,
          type: 'radio' as const,
          checked: cfg.displayId === display.id,
          click: () => patch({ displayId: display.id, x: null, y: null }),
        })),
      ],
    },
    { type: 'separator' },
    { label: `CalicoPet v${app.getVersion()}`, enabled: false },
    { label: '退出', click: () => app.quit() },
  ];
}

/** Re-clamp both native window and renderer after DPI/display topology changes. */
function handleDisplayChange(): void {
  if (!win) return;
  const cfg = store.all();
  const area = activeArea();
  const bounds = win.getContentBounds();
  const s = spriteSize(cfg.scale);
  const anchor = clampAnchorToArea(
    bounds.x + WINDOW_PAD + s.w / 2,
    bounds.y + WINDOW_PAD + s.h,
    area,
    cfg.scale,
  );
  moveWindowToAnchor(anchor.x, anchor.y);
  win.webContents.send('pet:frame', frameInfo());
  tray?.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip('桌宠猫咪 · 左键摸头 / 右键菜单');
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  tray.on('click', () => {
    if (manuallyHidden) togglePetVisibility();
    else win?.webContents.send('pet:pat');
  });
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
  ipcMain.on('pet:pos', (_e, pos: { x: number; y: number; seq?: number; displayPoint?: Point }) => {
    if (pos.displayPoint) setAutoDisplayFromPoint(pos.displayPoint);
    moveWindowToAnchor(pos.x, pos.y, pos.seq ?? 0);
  });

  // Native hit region: outside these rectangles Windows delivers input to the
  // window behind the pet. Rectangles arrive in content-local DIP coordinates.
  ipcMain.on('pet:setShape', (_e, rects: Rectangle[]) => {
    if (!win || win.isDestroyed() || !Array.isArray(rects) || rects.length > 3000) return;
    const bounds = win.getContentBounds();
    const clean: Rectangle[] = [];
    for (const r of rects) {
      if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
      const x0 = Math.max(0, Math.floor(r.x));
      const y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(bounds.width, Math.ceil(r.x + r.width));
      const y1 = Math.min(bounds.height, Math.ceil(r.y + r.height));
      if (x1 > x0 && y1 > y0) clean.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
    if (clean.length === 0) return;
    try {
      win.setShape(clean);
      latestShape = clean;
      shapeVersion++;
      shapeStats.updates++;
      shapeStats.rectangles = clean.length;
    } catch (err) {
      shapeStats.errors++;
      console.error('[main] native window shape failed:', err);
      win.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }]);
    }
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
    e.returnValue = win?.getContentBounds() ?? null;
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
          console.log('[smoke] window bounds:', JSON.stringify(win?.getContentBounds()));
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
    const bounds = win!.getContentBounds();
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
      const b = win?.getContentBounds();
      if (b) {
        samples.push(b.x);
        ySamples.push(b.y);
      }
    }, 16);
    // Sample long enough to include at least one roam leg even when the pet
    // starts a rest period; 2.6s could contain no movement at all.
    await js('window.__petTest && window.__petTest.info()');
    await new Promise((r) => setTimeout(r, 3800));
    clearInterval(timer);

    let flipsX = 0;
    let flipsY = 0;
    let maxStepX = 0;
    let maxStepY = 0;
    let pathX = 0;          // total horizontal distance travelled
    let pathY = 0;          // total vertical distance travelled
    const movingStepsX: number[] = [];
    const movingStepsY: number[] = [];
    for (let i = 2; i < samples.length; i++) {
      const d1 = samples[i - 1] - samples[i - 2];
      const d2 = samples[i] - samples[i - 1];
      if (d1 !== 0 || d2 !== 0) {
        if (Math.sign(d1) !== 0 && Math.sign(d2) !== 0 && Math.sign(d1) !== Math.sign(d2)) flipsX++;
      }
      maxStepX = Math.max(maxStepX, Math.abs(d2));
      pathX += Math.abs(d2);
      if (d2 !== 0) movingStepsX.push(Math.abs(d2));
    }
    for (let i = 2; i < ySamples.length; i++) {
      const d1 = ySamples[i - 1] - ySamples[i - 2];
      const d2 = ySamples[i] - ySamples[i - 1];
      if (Math.sign(d1) !== 0 && Math.sign(d2) !== 0 && Math.sign(d1) !== Math.sign(d2)) flipsY++;
      maxStepY = Math.max(maxStepY, Math.abs(d2));
      pathY += Math.abs(d2);
      if (d2 !== 0) movingStepsY.push(Math.abs(d2));
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
    const median = (xs: number[]) => {
      if (!xs.length) return 0;
      const sorted = xs.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
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
        pathY,
        flipsX,
        flipsY,
        maxStepX,
        maxStepY,
        // Steps over zero only: a resting pet contributes 0px samples and
        // would otherwise make any batch size look like a small median.
        medianStepX: median(movingStepsX),
        medianStepY: median(movingStepsY),
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
        windowBounds: win!.getContentBounds(),
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
            bubbles: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            screenX: r.left + r.width / 2,
            screenY: r.top + r.height / 2,
            button: 0,
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
      // Screen coordinates are authoritative. Deliberately give pointermove a
      // wrong clientX, simulating the synthetic mouse events Windows emits when
      // the window moves underneath a stationary cursor. A client-coordinate
      // implementation would drift by this offset; screenX must ignore it.
      const ev = (type, sx, sy, buttons, button) => {
        const r = t.info().windowRect;
        window.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
          isPrimary: true, button: button, buttons: buttons,
          clientX: sx - r.x + (type === 'pointermove' ? 240 : 0),
          clientY: sy - r.y,
          screenX: sx, screenY: sy,
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
      // Let the native window finish catching up with the setup drags before
      // the measured legs begin; otherwise a slow IPC echo from setup is
      // misreported as pointer-follow latency.
      await new Promise((resolve) => setTimeout(resolve, 250));
      let setupLag = -1;
      for (let i = 0; i < 20; i++) {
        const real = window.pet.realBounds();
        const rendered = t.info().windowRect;
        setupLag = real ? Math.round(Math.hypot(real.x - rendered.x, real.y - rendered.y)) : -1;
        if (setupLag >= 0 && setupLag <= 2) break;
        await frame();
      }
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
        // Compare the ACTUAL native origin with the origin the pet's current
        // position requires. The renderer's windowRect cache deliberately waits
        // for the real echo (drawing must not lead the native window), so
        // comparing against that cache would measure IPC latency, not whether
        // the visible pet is following the pointer.
        const started = performance.now();
        let r = null;
        let info = t.info();
        let expectedX = 0;
        let expectedY = 0;
        let lag = -1;
        // The app updates the window at 60Hz, while rAF can run at 165Hz. A
        // measurement after "two rAFs" can therefore legitimately precede the
        // next app tick. Poll until the window has settled, and assert that it
        // settles within a few 60Hz frames rather than immediately.
        for (let i = 0; i < 20; i++) {
          r = window.pet.realBounds();
          info = t.info();
          expectedX = Math.round(info.pet.x - P.pad - (P.nativeW * info.pet.scale) / 2);
          expectedY = Math.round(info.pet.y - P.pad - P.nativeH * info.pet.scale);
          lag = r ? Math.round(Math.hypot(r.x - expectedX, r.y - expectedY)) : -1;
          if (lag >= 0 && lag <= 2) break;
          if (performance.now() - started > 120) break;
          await frame();
        }
        return {
          lag,
          settleMs: Math.round(performance.now() - started),
          info,
          actual: r ? { x: r.x, y: r.y } : null,
          expected: { x: expectedX, y: expectedY },
          rendered: { x: info.windowRect.x, y: info.windowRect.y },
        };
      };
      const farLeg = await leg(p1.x, p1.y);
      const afterFar = farLeg.info;
      const midLeg = await leg(p2.x, p2.y);
      const afterMid = midLeg.info;
      const thirdLeg = await leg(p3.x, p3.y);
      const afterThird = thirdLeg.info;
      const lagSamples = [farLeg.lag, midLeg.lag, thirdLeg.lag];
      const settleSamples = [farLeg.settleMs, midLeg.settleMs, thirdLeg.settleMs];
      const lagDetail = [farLeg, midLeg, thirdLeg].map((x) => ({
        lag: x.lag,
        settleMs: x.settleMs,
        actual: x.actual,
        expected: x.expected,
        rendered: x.rendered,
      }));

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
        lagSamples, settleSamples, lagDetail, setupLag,
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
      nativeW: SPRITE_NATIVE.w,
      nativeH: SPRITE_NATIVE.h,
      pad: WINDOW_PAD,
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
    const settleSamples = (res.settleSamples as number[] | undefined) ?? [];
    const dragWindowDrift = lagSamples.length ? Math.max(...lagSamples) : -1;
    const dragWindowSettleMs = settleSamples.length ? Math.max(...settleSamples) : -1;
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
        // The window must catch the cat within a few 60Hz frames while dragging.
        dragWindowDrift,
        dragWindowSettleMs,
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
          (mid as { facing?: number })?.facing === 1 &&
          dragWindowDrift <= 20 &&
          dragWindowSettleMs <= 50,
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
      const real = win?.getContentBounds();
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

  // "gait": the walk animation must follow real locomotion, not merely the
  // selected mode. Regression guard for the cat walking in place during a roam
  // rest (and after follow has already arrived).
  if (TEST_PROBE === 'gait') {
    const res = (await js(`(async () => {
      const t = window.__petTest;
      if (!t) return null;
      const base = () => t.animState().base;
      const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await t.patch({ mode: 'rest', paused: false });
      await settle(250);
      const resting = base();
      await t.patch({ mode: 'roam', roamSpeed: 'slow' });
      await settle(350);
      const moving = base();
      await t.patch({ mode: 'rest' });
      await settle(550);
      const stopped = base();
      return { resting, moving, stopped };
    })`)) as null | { resting: string; moving: string; stopped: string };
    return {
      gaitCheck: {
        ...res,
        ok: !!res && res.moving === 'walk' && res.resting !== 'walk' && res.stopped !== 'walk',
      },
    };
  }

  // "hitgrid": sweep the hit test across the whole window and report the screen
  // rectangle where it says "yes". Direct way to catch an offset between the
  // drawn cat and the clickable area.
  if (TEST_PROBE === 'hitgrid') {
    const bounds = win!.getContentBounds();
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

    // Where the cat is actually drawn, in screen coordinates. `local` is the
    // bottom-centre inside the window, so no extra pad belongs in this formula:
    // the canvas covers the whole window and draw() applies the pad itself.
    const drawnScreen = {
      x: Math.round(bounds.x + res.local.x - res.sprite.w / 2),
      y: Math.round(bounds.y + res.local.y - res.sprite.h),
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

    // The hit mask follows the cat's alpha silhouette, which is naturally
    // smaller than the sprite's bounding box (and not centred inside it because
    // of the tail). Compare containment with a 1px tolerance instead of
    // demanding equal bounds -- the old width/height check could never pass for
    // a real silhouette.
    const ok =
      !!hitScreen &&
      res.hits > 0 &&
      hitScreen.x >= drawnScreen.x - 1 &&
      hitScreen.y >= drawnScreen.y - 1 &&
      hitScreen.x + hitScreen.w <= drawnScreen.x + drawnScreen.w + 1 &&
      hitScreen.y + hitScreen.h <= drawnScreen.y + drawnScreen.h + 1;

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

  if (TEST_PROBE === 'gesture') {
    const result = await js(`async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = window.__petTest;
      const canvas = document.getElementById('pet');
      const fire = (type, x, y) => {
        const info = t.info();
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 7, isPrimary: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1,
          clientX: x - info.windowRect.x, clientY: y - info.windowRect.y,
          screenX: x, screenY: y,
        }));
      };
      const point = () => {
        const info = t.info();
        return { x: Math.round(info.pet.x), y: Math.round(info.pet.y - 60) };
      };
      const history = (mark) => t.animState().history.slice(mark).map((h) => h.override).filter(Boolean);
      await t.patch({ paused: false });
      await sleep(900);

      let p = point();
      let mark = t.animState().history.length;
      fire('pointerdown', p.x, p.y); fire('pointerup', p.x, p.y);
      await sleep(40);
      const clickHadNoImmediateCarry = t.animState().override !== 'carry' && !t.animState().dragging;
      await sleep(340);
      const single = history(mark);
      await sleep(850);

      p = point(); mark = t.animState().history.length;
      fire('pointerdown', p.x, p.y); fire('pointerup', p.x, p.y);
      await sleep(60);
      fire('pointerdown', p.x, p.y); fire('pointerup', p.x, p.y);
      await sleep(340);
      const double = history(mark);
      await sleep(900);

      p = point(); mark = t.animState().history.length;
      fire('pointerdown', p.x, p.y);
      fire('pointermove', p.x + 90, p.y - 60);
      await sleep(40);
      fire('pointerup', p.x + 90, p.y - 60);
      await sleep(80);
      const drag = history(mark);

      await t.patch({ paused: true }); await sleep(60);
      mark = t.animState().history.length;
      t.trayPat(); await sleep(340);
      const pausedTray = history(mark);

      await t.patch({ paused: false }); await sleep(60);
      p = point();
      fire('pointerdown', p.x, p.y);
      fire('pointermove', p.x + 80, p.y - 40);
      await sleep(40);
      await t.patch({ paused: true }); await sleep(80);
      const pauseEndedDrag = !t.animState().dragging;
      fire('pointerup', p.x + 80, p.y - 40);
      await t.patch({ paused: false });

      const ok = clickHadNoImmediateCarry &&
        single.length === 1 && single[0] === 'pat' &&
        double.length === 1 && double[0] === 'angry' &&
        drag.includes('carry') && !drag.includes('pat') && !drag.includes('angry') &&
        pausedTray.length === 0 && pauseEndedDrag;
      return { clickHadNoImmediateCarry, single, double, drag, pausedTray, pauseEndedDrag, ok };
    }`);
    return { gestureCheck: result };
  }

  if (TEST_PROBE === 'perf') {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const read = async () => await js(`() => {
      const i = window.__petTest.info();
      return { loops: i.activity.loopCount, perf: i.perf, shape: i.shape };
    }`) as {
      loops: number;
      perf: { draws: number; maskBuilds: number; positionReports: number };
      shape: { rectangles: number; revision: number };
    };
    await js('window.__petTrace = false;');
    applyPowerSaving(false);
    await wait(400);
    const idle0 = await read();
    await wait(1100);
    const idle1 = await read();

    await js('async () => { await window.__petTest.patch({ paused: true }); }');
    await wait(150);
    const paused0 = await read();
    await wait(300);
    const paused1 = await read();

    await js('async () => { await window.__petTest.patch({ paused: false, mode: "roam" }); window.__petTrace = true; }');
    applyPowerSaving(false);
    await wait(400);
    const motion0 = await read();
    await wait(1000);
    const motion1 = await read();

    applyPowerSaving(true);
    await wait(200);
    const saver0 = await read();
    await wait(1000);
    const saver1 = await read();
    applyPowerSaving(false);
    await js('window.__petTrace = false;');

    const idleLoops = idle1.loops - idle0.loops;
    const idleDraws = idle1.perf.draws - idle0.perf.draws;
    const normalLoops = motion1.loops - motion0.loops;
    const saverLoops = saver1.loops - saver0.loops;
    const maskBuilds = motion1.perf.maskBuilds - motion0.perf.maskBuilds;
    const shapeUpdates = motion1.shape.revision - motion0.shape.revision;
    const positionReports = motion1.perf.positionReports - motion0.perf.positionReports;
    const pausedStable = paused1.loops === paused0.loops;
    const maskEfficient = maskBuilds <= Math.max(4, Math.ceil(normalLoops / 3));
    const result = {
      idleLoops,
      idleDraws,
      pausedStable,
      normalLoops,
      saverLoops,
      maskBuilds,
      shapeUpdates,
      positionReports,
      maskEfficient,
      idleBounded: idleLoops <= 15 && idleDraws <= idleLoops + 1,
      normal60Hz: normalLoops >= 40 && normalLoops <= 75,
      saver30Hz: saverLoops >= 18 && saverLoops <= 45 && saverLoops < normalLoops * 0.8,
      shapeBounded: shapeUpdates <= normalLoops,
      reportsBounded: positionReports <= normalLoops + 3,
    };
    const ok = pausedStable && maskEfficient && result.idleBounded && result.normal60Hz &&
      result.saver30Hz && result.shapeBounded && result.reportsBounded;
    return { perfCheck: { ...result, ok } };
  }

  if (TEST_PROBE === 'recovery') {
    const wc = win!.webContents;
    const reloaded = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      wc.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    wc.debugger.attach('1.3');
    void wc.debugger.sendCommand('Page.crash').catch(() => {
      // The target disappears before CDP can acknowledge Page.crash.
    });
    const didReload = await reloaded;
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const next = await js('window.__petDiag ?? null') as SmokeDiag | null;
        ready = next?.ready === true;
      } catch {
        // Renderer is still being recreated.
      }
    }
    return {
      recoveryCheck: {
        didReload,
        ready,
        attempts: rendererRecoveryAttempts,
        ok: didReload && ready && rendererRecoveryAttempts === 1,
      },
    };
  }

  if (TEST_PROBE === 'shape') {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const inside = (rects: Rectangle[], x: number, y: number) => rects.some((r) =>
      x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    const snapshot = () => ({
      version: shapeVersion,
      rects: latestShape.map((r) => ({ ...r })),
      bounds: win!.getContentBounds(),
      stats: { ...shapeStats },
    });
    await wait(350);
    const initial = snapshot();
    const scale3 = store.all().scale;
    const body3 = { x: WINDOW_PAD + 38 * scale3, y: WINDOW_PAD + 45 * scale3 };
    const initialBody = inside(initial.rects, body3.x, body3.y);
    const initialPaddingExcluded = !inside(initial.rects, 1, 1);
    const initialBounded = initial.rects.every((r) =>
      r.x >= 0 && r.y >= 0 && r.x + r.width <= initial.bounds.width && r.y + r.height <= initial.bounds.height);

    patch({ scale: 4 });
    await wait(450);
    const scaled = snapshot();
    const body4 = { x: WINDOW_PAD + 38 * 4, y: WINDOW_PAD + 45 * 4 };
    const scaleUpdated = scaled.version > initial.version && scaled.bounds.width === 76 * 4 + WINDOW_PAD * 2 &&
      scaled.bounds.height === 68 * 4 + WINDOW_PAD * 2;
    const scaledBody = inside(scaled.rects, body4.x, body4.y);
    patch({ scale: 3 });
    await wait(350);
    const restored = snapshot();
    const result = {
      rectangles: initial.rects.length,
      scaledRectangles: scaled.rects.length,
      initialBody,
      initialPaddingExcluded,
      initialBounded,
      scaleUpdated,
      scaledBody,
      restored: restored.version > scaled.version,
      errors: shapeStats.errors,
    };
    const ok = result.rectangles > 3 && result.rectangles <= 3000 && initialBody &&
      initialPaddingExcluded && initialBounded && scaleUpdated && scaledBody &&
      result.restored && shapeStats.errors === 0;
    return { shapeCheck: { ...result, ok } };
  }

  if (TEST_PROBE === 'pixels') {
    // Capture the REAL backing store at the current DPI. Besides checking the
    // source dimensions, this rejects interpolated alpha/colours and leaves a
    // PNG for human inspection. It runs only in an isolated smoke instance.
    await new Promise((r) => setTimeout(r, 350));
    const capturePixels = async () => (await js(`() => {
      const t = window.__petTest;
      const frame = t && t.currentFrame();
      const canvas = document.querySelector('canvas');
      if (!frame || !canvas) return { error: 'missing frame or canvas' };
      const ctx = canvas.getContext('2d');
      const output = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const composition = t.pixelAudit();
      const source = document.createElement('canvas');
      source.width = frame.naturalWidth;
      source.height = frame.naturalHeight;
      const sctx = source.getContext('2d');
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(frame, 0, 0);
      const input = sctx.getImageData(0, 0, source.width, source.height).data;
      const sw = source.width, sh = source.height;
      const colourAt = (x, y) => {
        if (x < 0 || x >= sw || y < 0 || y >= sh) return -1;
        const i = (y * sw + x) * 4;
        if (input[i + 3] === 0) return -1;
        return (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
      };
      let exposedEarRim = 0;
      for (let y = 0; y < Math.min(28, sh); y++) {
        for (let x = 0; x < sw; x++) {
          if ((x >= 30 && x <= 42) || colourAt(x, y) !== 0x181411) continue;
          if ([[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => colourAt(nx, ny) === -1)) {
            exposedEarRim++;
          }
        }
      }
      const ink = 0x1e1915, whisker = 0xd6cec2;
      const art = new Uint8Array(sw * sh);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const colour = colourAt(x, y);
          if (colour !== -1 && colour !== ink && colour !== whisker) art[y * sw + x] = 1;
        }
      }
      // Flood only the background connected to the canvas exterior. This lets
      // the check distinguish the requested outer ring from internal pinholes.
      const exterior = new Uint8Array(sw * sh);
      const flood = [];
      const addExterior = (x, y) => {
        if (x < 0 || x >= sw || y < 0 || y >= sh) return;
        const at = y * sw + x;
        if (!art[at] && !exterior[at]) {
          exterior[at] = 1;
          flood.push(at);
        }
      };
      for (let x = 0; x < sw; x++) { addExterior(x, 0); addExterior(x, sh - 1); }
      for (let y = 0; y < sh; y++) { addExterior(0, y); addExterior(sw - 1, y); }
      while (flood.length) {
        const at = flood.pop();
        const x = at % sw, y = Math.floor(at / sw);
        addExterior(x - 1, y); addExterior(x + 1, y);
        addExterior(x, y - 1); addExterior(x, y + 1);
      }
      let exposedNonOutline = 0, internalOutline = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const at = y * sw + x;
          if (colourAt(x, y) === ink && !exterior[at]) internalOutline++;
          if (!art[at]) continue;
          let exposed = false;
          for (let dy = -1; dy <= 1 && !exposed; dy++) {
            for (let dx = -1; dx <= 1 && !exposed; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) { exposed = true; break; }
              const next = ny * sw + nx;
              if (exterior[next] && input[next * 4 + 3] === 0) exposed = true;
            }
          }
          if (exposed) exposedNonOutline++;
        }
      }
      const visited = new Uint8Array(sw * sh);
      let outerOutlineComponents = 0, shortOutlineFragments = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const start = y * sw + x;
          if (visited[start] || colourAt(x, y) !== ink) continue;
          outerOutlineComponents++;
          let size = 0;
          const stack = [start];
          visited[start] = 1;
          while (stack.length) {
            const at = stack.pop();
            const cx = at % sw, cy = Math.floor(at / sw);
            size++;
            for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
              if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) continue;
              const next = ny * sw + nx;
              if (!visited[next] && colourAt(nx, ny) === ink) {
                visited[next] = 1;
                stack.push(next);
              }
            }
          }
          if (size <= 4) shortOutlineFragments++;
        }
      }
      const palette = new Set();
      for (let i = 0; i < input.length; i += 4) {
        if (input[i + 3] > 0) palette.add((input[i] << 16) | (input[i + 1] << 8) | input[i + 2]);
      }
      const alpha = new Set();
      const unexpected = new Set();
      let drawnPixels = 0;
      for (let i = 0; i < output.length; i += 4) {
        const a = output[i + 3];
        if (a === 0) continue;
        drawnPixels++;
        alpha.add(a);
        const colour = (output[i] << 16) | (output[i + 1] << 8) | output[i + 2];
        if (!palette.has(colour)) unexpected.add(colour);
      }
      return {
        nativeWidth: frame.naturalWidth,
        nativeHeight: frame.naturalHeight,
        frame: frame.src.split('/').pop(),
        drawnPixels,
        exposedEarRim,
        exposedNonOutline,
        internalOutline,
        outerOutlineComponents,
        shortOutlineFragments,
        stalePixels: composition.stalePixels,
        missingPixels: composition.missingPixels,
        changedPixels: composition.changedPixels,
        mismatchedPixels: composition.mismatchedPixels,
        expectedDataUrl: composition.expectedDataUrl,
        alphaValues: [...alpha],
        unexpectedColors: [...unexpected],
        dpr: window.devicePixelRatio,
        dataUrl: canvas.toDataURL('image/png'),
      };
    }`)) as {
      nativeWidth?: number; nativeHeight?: number; drawnPixels?: number; frame?: string;
      exposedEarRim?: number; shortOutlineFragments?: number;
      exposedNonOutline?: number; internalOutline?: number; outerOutlineComponents?: number;
      stalePixels?: number; missingPixels?: number; changedPixels?: number; mismatchedPixels?: number;
      alphaValues?: number[]; unexpectedColors?: number[]; dpr?: number;
      dataUrl?: string; expectedDataUrl?: string; error?: string;
    };
    const result = await capturePixels();

    // Exercise the other pose from the user's report through the real drag path.
    // This catches an asset that is clean on disk but stale or incorrectly drawn
    // only while the carry override is active.
    await js(`(async () => {
      const t = window.__petTest;
      await t.patch({ paused: false, mode: 'rest' });
      const info = t.info();
      const grab = { x: info.pet.x, y: info.pet.y - 34 * info.pet.scale };
      t.beginDrag(grab.x, grab.y);
      t.updateDrag(grab.x + 24, grab.y - 48);
    })`);
    await new Promise((r) => setTimeout(r, 1250));
    const carryResult = await capturePixels();
    await js(`(async () => {
      const t = window.__petTest;
      t.finishDrag();
      await t.patch({ paused: true });
    })`);

    const capture = LOG_FILE ? LOG_FILE.replace(/\.log$/i, '') + '.png' : '';
    const carryCapture = LOG_FILE ? LOG_FILE.replace(/\.log$/i, '') + '-carry.png' : '';
    const expectedCapture = LOG_FILE ? LOG_FILE.replace(/\.log$/i, '') + '-expected.png' : '';
    const carryExpectedCapture = LOG_FILE ? LOG_FILE.replace(/\.log$/i, '') + '-carry-expected.png' : '';
    if (capture && result.dataUrl) {
      writeFileSync(capture, Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(',') + 1), 'base64'));
    }
    if (carryCapture && carryResult.dataUrl) {
      writeFileSync(carryCapture, Buffer.from(carryResult.dataUrl.slice(carryResult.dataUrl.indexOf(',') + 1), 'base64'));
    }
    if (expectedCapture && result.expectedDataUrl) {
      writeFileSync(expectedCapture, Buffer.from(result.expectedDataUrl.slice(result.expectedDataUrl.indexOf(',') + 1), 'base64'));
    }
    if (carryExpectedCapture && carryResult.expectedDataUrl) {
      writeFileSync(carryExpectedCapture, Buffer.from(carryResult.expectedDataUrl.slice(carryResult.expectedDataUrl.indexOf(',') + 1), 'base64'));
    }
    const valid = (r: typeof result) => r.nativeWidth === SPRITE_NATIVE.w && r.nativeHeight === SPRITE_NATIVE.h &&
      (r.drawnPixels ?? 0) > 1000 && r.exposedEarRim === 0 && r.exposedNonOutline === 0 &&
      r.internalOutline === 0 && r.outerOutlineComponents === 1 && r.shortOutlineFragments === 0 &&
      r.stalePixels === 0 && r.missingPixels === 0 && r.changedPixels === 0 && r.mismatchedPixels === 0 &&
      (r.alphaValues ?? []).every((a) => a === 255) &&
      (r.unexpectedColors ?? []).length === 0;
    const { dataUrl: _dataUrl, expectedDataUrl: _expectedDataUrl, ...report } = result;
    const { dataUrl: _carryDataUrl, expectedDataUrl: _carryExpectedDataUrl, ...carryReport } = carryResult;
    const carryOk = valid(carryResult) && Boolean(carryResult.frame?.startsWith('carry_'));
    const ok = valid(result) && carryOk;
    return { pixelCheck: { ...report, capture, carry: { ...carryReport, capture: carryCapture, ok: carryOk }, ok } };
  }

  if (TEST_PROBE === 'power') {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const read = async () => await js(`() => {
      const d = window.__petDiag;
      return d ? {
        active: d.active, powerSaving: d.powerSaving, motionHz: d.motionHz,
        loopCount: d.loopCount, activityResets: d.activityResets,
      } : null;
    }`) as {
      active: boolean; powerSaving: boolean; motionHz: number;
      loopCount: number; activityResets: number;
    } | null;
    await js('window.__petTrace = true;');
    await wait(120);
    const initial = await read();
    await wait(140);
    const running = await read();
    const pausedBefore = store.all().paused;

    togglePetVisibility();
    await wait(70);
    const hidden = await read();
    const hiddenLoop = hidden?.loopCount ?? -1;
    const hiddenCursorStopped = cursorTimer === null;
    const hiddenInvisible = win?.isVisible() === false;
    await wait(180);
    const hiddenLater = await read();

    togglePetVisibility();
    await wait(120);
    const restored = await read();

    screenLocked = true;
    syncActivity();
    await wait(70);
    const locked = await read();
    const lockedLoop = locked?.loopCount ?? -1;
    await wait(160);
    const lockedLater = await read();
    screenLocked = false;
    syncActivity();
    await wait(100);

    applyPowerSaving(true);
    await wait(100);
    const saver = await read();
    applyPowerSaving(false);
    await wait(100);
    const normal = await read();
    refreshPowerSaving();

    const result = {
      initialActive: initial?.active === true,
      baselineAdvanced: !!running && !!initial && running.loopCount > initial.loopCount,
      hiddenStopped: hidden?.active === false && hiddenLater?.loopCount === hiddenLoop,
      hiddenInvisible,
      hiddenCursorStopped,
      restored: restored?.active === true && restored.loopCount > hiddenLoop &&
        restored.activityResets > (initial?.activityResets ?? 0),
      lockStopped: locked?.active === false && lockedLater?.loopCount === lockedLoop,
      saver30Hz: saver?.powerSaving === true && saver.motionHz === 30,
      normal60Hz: normal?.powerSaving === false && normal.motionHz === 60,
      pausedPreserved: store.all().paused === pausedBefore,
      onBattery: powerMonitor.isOnBatteryPower(),
    };
    const { onBattery, ...checks } = result;
    return { powerCheck: { ...result, ok: Object.values(checks).every(Boolean) } };
  }

  if (TEST_PROBE === 'display') {
    const primary = screen.getPrimaryDisplay();
    patch({ displayId: primary.id, x: null, y: null });
    await new Promise((r) => setTimeout(r, 450));
    const fixedDiag = (await js('window.__petDiag ?? null')) as SmokeDiag | null;
    const fixedArea = activeArea();
    const fixedInside = !!fixedDiag &&
      fixedDiag.pos.x >= fixedArea.x && fixedDiag.pos.x <= fixedArea.x + fixedArea.width &&
      fixedDiag.pos.y >= fixedArea.y && fixedDiag.pos.y <= fixedArea.y + fixedArea.height;

    patch({ displayId: null });
    handleDisplayChange();
    await new Promise((r) => setTimeout(r, 250));
    const autoArea = activeArea();
    const autoPreserved = autoArea.x === primary.workArea.x && autoArea.y === primary.workArea.y &&
      autoArea.width === primary.workArea.width && autoArea.height === primary.workArea.height;

    // Simulate a stale off-screen position after a display is removed. Main must
    // clamp the native window even before the renderer's next animation tick.
    moveWindowToAnchor(autoArea.x - 10000, autoArea.y + 10000);
    const b = win!.getContentBounds();
    const s = spriteSize(store.all().scale);
    const actualAnchor = { x: b.x + WINDOW_PAD + s.w / 2, y: b.y + WINDOW_PAD + s.h };
    const expected = clampAnchorToArea(autoArea.x - 10000, autoArea.y + 10000, autoArea, store.all().scale);
    const clamped = Math.abs(actualAnchor.x - expected.x) <= 1 && Math.abs(actualAnchor.y - expected.y) <= 1;
    return {
      displayCheck: {
        displays: screen.getAllDisplays().map((d) => ({ id: d.id, scaleFactor: d.scaleFactor, workArea: d.workArea })),
        fixedInside,
        autoPreserved,
        clamped,
        actualAnchor,
        expected,
        ok: fixedInside && autoPreserved && clamped,
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
    manuallyHidden = false;
    syncActivity();
    win?.showInactive();
    win?.webContents.send('pet:pat');
    refreshTrayMenu();
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
    refreshPowerSaving();

    powerMonitor.on('on-battery', refreshPowerSaving);
    powerMonitor.on('on-ac', refreshPowerSaving);
    powerMonitor.on('lock-screen', () => {
      screenLocked = true;
      syncActivity();
    });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      syncActivity();
    });
    powerMonitor.on('suspend', () => {
      systemSuspended = true;
      syncActivity();
    });
    powerMonitor.on('resume', () => {
      systemSuspended = false;
      syncActivity();
      refreshPowerSaving();
    });

    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);
  });

  app.on('before-quit', () => {
    quitting = true;
    store.saveNow();
  });

  app.on('window-all-closed', () => {
    // the pet has no taskbar entry: closing every window means "quit"
    app.quit();
  });
}
