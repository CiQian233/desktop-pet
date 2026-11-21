import { contextBridge, ipcRenderer } from 'electron';
import type { PetConfig } from './config';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInfo {
  config: PetConfig;
  windowRect: Rect;
  workArea: Rect;
  pad: number;
  version: string;
  activityActive: boolean;
  powerSaving: boolean;
  /** true only for automated runs; enables the renderer's introspection hook */
  testMode: boolean;
}

export interface PetBridge {
  ready(): Promise<FrameInfo>;
  patch(part: Partial<PetConfig>): Promise<PetConfig>;
  /** report the pet's feet position in work-area coordinates */
  setPos(pos: { x: number; y: number; seq: number; displayPoint?: { x: number; y: number } }): void;
  setShape(rects: Rect[]): void;
  requestFrame(): void;
  openMenu(): void;
  showBubble(payload: { name: string; text: string; kind: string; period: string }): void;
  quit(): void;
  /** config bridge, so a probe can freeze the animation while measuring */
  realBounds(): { x: number; y: number } | null;
  onConfig(cb: (cfg: PetConfig) => void): void;
  onFrame(cb: (info: FrameInfo) => void): void;
  /**
   * The window was moved to this origin (screen coordinates). Input handling
   * converts pointer client coordinates to screen coordinates with this value, so
   * losing it makes every hit test land in the wrong place.
   */
  onWindowMoved(cb: (origin: { x: number; y: number; width: number; height: number; seq: number }) => void): void;
  /** global cursor position, in screen coordinates (see main: syncCursorPolling) */
  onCursor(cb: (pos: { x: number; y: number }) => void): void;
  onRecenter(cb: (info: FrameInfo) => void): void;
  onPat(cb: () => void): void;
  onActivity(cb: (active: boolean) => void): void;
  onPowerSaving(cb: (enabled: boolean) => void): void;
  onNaturalPreview(cb: (key: string) => void): void;
}

const bridge: PetBridge = {
  ready: () => ipcRenderer.invoke('app:ready-bundle'),
  patch: (part) => ipcRenderer.invoke('config:patch', part),
  setPos: (pos) => ipcRenderer.send('pet:pos', pos),
  setShape: (rects) => ipcRenderer.send('pet:setShape', rects),
  requestFrame: () => ipcRenderer.send('pet:requestFrame'),
  openMenu: () => ipcRenderer.send('app:openMenu'),
  showBubble: (payload) => ipcRenderer.send('pet:bubble', payload),
  quit: () => ipcRenderer.send('app:quit'),
  realBounds: () => ipcRenderer.sendSync('pet:realBounds'),
  onConfig: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  onFrame: (cb) => ipcRenderer.on('pet:frame', (_e, info) => cb(info)),
  onWindowMoved: (cb) => ipcRenderer.on('pet:windowMoved', (_e, origin) => cb(origin)),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, pos) => cb(pos)),
  onRecenter: (cb) => ipcRenderer.on('pet:recenter', (_e, info) => cb(info)),
  onPat: (cb) => ipcRenderer.on('pet:pat', () => cb()),
  onActivity: (cb) => ipcRenderer.on('pet:activity', (_e, active) => cb(Boolean(active))),
  onPowerSaving: (cb) => ipcRenderer.on('pet:powerSaving', (_e, enabled) => cb(Boolean(enabled))),
  onNaturalPreview: (cb) => ipcRenderer.on('pet:previewNatural', (_e, key) => cb(String(key))),
};

contextBridge.exposeInMainWorld('pet', bridge);
