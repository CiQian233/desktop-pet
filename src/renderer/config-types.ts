/**
 * Renderer-side mirror of the main process contract.
 *
 * This bundle must not import from src/main (different tsconfig, and main pulls
 * in electron at runtime), so the contract is restated here. Keep the two in
 * sync -- src/main/preload.ts is the authoritative side.
 */

export type PetMode = 'rest' | 'roam' | 'follow';
export type PetScale = 2 | 3 | 4 | 6;
/** walking pace preset for roam mode; the pixel speeds live in core/controller */
export type RoamSpeed = 'slow' | 'normal' | 'fast';

export interface PetConfig {
  scale: PetScale;
  mode: PetMode;
  roamSpeed: RoamSpeed;
  paused: boolean;
  x: number | null;
  y: number | null;
  /** 1 = facing right, -1 = facing left (the artwork is drawn facing left) */
  facing: 1 | -1;
  autostart: boolean;
  alwaysOnTop: boolean;
  displayId: number | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInfo {
  config: PetConfig;
  /** the pet window's rectangle in screen coordinates */
  windowRect: Rect;
  workArea: Rect;
  pad: number;
  version: string;
  /** true only for automated runs; enables the renderer's introspection hook */
  testMode: boolean;
}

export interface Bridge {
  ready(): Promise<FrameInfo>;
  patch(part: Partial<PetConfig>): Promise<PetConfig>;
  setPos(pos: { x: number; y: number }): void;
  requestFrame(): void;
  openMenu(): void;
  quit(): void;
  realBounds(): { x: number; y: number } | null;
  onConfig(cb: (cfg: PetConfig) => void): void;
  onFrame(cb: (info: FrameInfo) => void): void;
  /**
   * The window was moved to this origin (screen coordinates). Input handling
   * converts pointer client coordinates to screen coordinates with this value, so
   * losing it makes every hit test land in the wrong place.
   */
  onWindowMoved(cb: (origin: { x: number; y: number }) => void): void;
  /** global cursor position in screen coordinates; the only cursor source that
   *  works outside the pet's own window (see main: syncCursorPolling) */
  onCursor(cb: (pos: { x: number; y: number }) => void): void;
  onRecenter(cb: (info: FrameInfo) => void): void;
  onPat(cb: () => void): void;
}

declare global {
  interface Window {
    pet: Bridge;
  }
}
