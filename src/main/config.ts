import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PetMode = 'rest' | 'roam' | 'follow';
export type PetScale = 2 | 3 | 4 | 6;
/** walking pace preset for roam mode (see ROAM_SPEED_PX) */
export type RoamSpeed = 'slow' | 'normal' | 'fast';

export interface PetConfig {
  /** display multiplier: 2 / 3 / 4 / 6 (default 3) */
  scale: PetScale;
  /** behaviour mode */
  mode: PetMode;
  /** walking pace in roam mode: slow / normal / fast (default normal) */
  roamSpeed: RoamSpeed;
  /** animation + movement frozen */
  paused: boolean;
  /** pet anchor (feet), window-local CSS px; null = place at default corner */
  x: number | null;
  y: number | null;
  /**
   * Which way the cat faces: 1 = right, -1 = left. The artwork is drawn facing
   * LEFT, so the renderer mirrors it when this is 1.
   *
   * NOTE: this is inverted relative to builds before session 8, which had
   * 1 = left. The old value is intentionally NOT migrated -- the wrong value is
   * what made the cat walk right while looking left, and the existing config in
   * %APPDATA% carries that wrong value.
   */
  facing: 1 | -1;
  /** launch the pet when Windows starts */
  autostart: boolean;
  /** keep the pet above other windows */
  alwaysOnTop: boolean;
  /** desktop index, for multi-monitor setups */
  displayId: number | null;
}

const DEFAULTS: PetConfig = {
  scale: 3,
  mode: 'rest',
  roamSpeed: 'normal',
  paused: false,
  x: null,
  y: null,
  facing: 1,
  autostart: false,
  alwaysOnTop: true,
  displayId: null,
};

function configPath(): string {
  return join(app.getPath('userData'), 'pet-config.json');
}

function coerce(raw: unknown): PetConfig {
  const out: PetConfig = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  if (r.scale === 2 || r.scale === 3 || r.scale === 4 || r.scale === 6) out.scale = r.scale;
  if (r.mode === 'rest' || r.mode === 'roam' || r.mode === 'follow') out.mode = r.mode;
  if (r.roamSpeed === 'slow' || r.roamSpeed === 'normal' || r.roamSpeed === 'fast') {
    out.roamSpeed = r.roamSpeed;
  }
  if (typeof r.paused === 'boolean') out.paused = r.paused;
  if (typeof r.x === 'number' && Number.isFinite(r.x)) out.x = r.x;
  if (typeof r.y === 'number' && Number.isFinite(r.y)) out.y = r.y;
  // Values written by builds before session 8 used the opposite convention
  // (1 = left). Re-reading them faithfully would keep the cat walking backwards,
  // so 1 is treated as "not persisted" and falls back to the default (right);
  // -1 means the same thing it always did (left) and is kept.
  if (r.facing === -1) out.facing = -1;
  if (typeof r.autostart === 'boolean') out.autostart = r.autostart;
  if (typeof r.alwaysOnTop === 'boolean') out.alwaysOnTop = r.alwaysOnTop;
  if (typeof r.displayId === 'number') out.displayId = r.displayId;
  return out;
}

export class ConfigStore {
  private data: PetConfig = { ...DEFAULTS };
  private saveTimer: NodeJS.Timeout | null = null;
  private readOnly = false;

  /** smoke runs must never touch the user's real config file */
  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  load(): PetConfig {
    try {
      const file = configPath();
      if (existsSync(file)) {
        this.data = coerce(JSON.parse(readFileSync(file, 'utf8')));
        console.log(`[config] loaded ${file}`, JSON.stringify(this.data));
      } else {
        console.log(`[config] no file at ${file}, using defaults`);
        this.data = { ...DEFAULTS };
      }
    } catch (err) {
      console.error('[config] failed to read, using defaults:', err);
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  all(): PetConfig {
    return this.data;
  }

  /** merge a partial update and schedule a debounced write */
  patch(part: Partial<PetConfig>): PetConfig {
    this.data = coerce({ ...this.data, ...part });
    this.scheduleSave();
    return this.data;
  }

  /**
   * Drop everything persisted and start from defaults plus `part`, without
   * writing to disk. Used by the smoke tests so every case is reproducible and
   * the real user config is never touched.
   */
  reset(part: Partial<PetConfig> = {}): PetConfig {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.data = coerce({ ...DEFAULTS, ...part });
    return this.data;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return;
    try {
      const file = configPath();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, file); // atomic-ish: never leave a half-written config
    } catch (err) {
      console.error('[config] save failed:', err);
    }
  }
}
