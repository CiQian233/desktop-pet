import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type PetMode = 'rest' | 'roam' | 'follow';
export type PetScale = 2 | 3 | 4 | 6;
export type RoamSpeed = 'slow' | 'normal' | 'fast';
export type PetPersonality = 'gentle' | 'lively' | 'aloof';
export type NaturalFrequency = 'low' | 'normal' | 'high';

export interface PetConfig {
  configVersion: 1;
  scale: PetScale;
  mode: PetMode;
  roamSpeed: RoamSpeed;
  paused: boolean;
  x: number | null;
  y: number | null;
  /** 1 = right, -1 = left; artwork itself faces left */
  facing: 1 | -1;
  autostart: boolean;
  alwaysOnTop: boolean;
  displayId: number | null;
  batterySaver: boolean;
  petName: string;
  personality: PetPersonality;
  bubblesEnabled: boolean;
  randomChatter: boolean;
  naturalEnabled: boolean;
  naturalFrequency: NaturalFrequency;
}

export const DEFAULT_CONFIG: PetConfig = {
  configVersion: 1,
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
  batterySaver: true,
  petName: '三花',
  personality: 'gentle',
  bubblesEnabled: true,
  randomChatter: true,
  naturalEnabled: true,
  naturalFrequency: 'low',
};

/** Coerce untyped/old JSON into the current schema without trusting its content. */
export function coerceConfig(raw: unknown): PetConfig {
  const out: PetConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.scale === 2 || r.scale === 3 || r.scale === 4 || r.scale === 6) out.scale = r.scale;
  if (r.mode === 'rest' || r.mode === 'roam' || r.mode === 'follow') out.mode = r.mode;
  if (r.roamSpeed === 'slow' || r.roamSpeed === 'normal' || r.roamSpeed === 'fast') out.roamSpeed = r.roamSpeed;
  if (typeof r.paused === 'boolean') out.paused = r.paused;
  if (typeof r.x === 'number' && Number.isFinite(r.x)) out.x = r.x;
  if (typeof r.y === 'number' && Number.isFinite(r.y)) out.y = r.y;
  // Pre-session-8 builds persisted the opposite facing convention. Keep the
  // established migration: only -1 is meaningful from those files.
  if (r.facing === -1) out.facing = -1;
  if (typeof r.autostart === 'boolean') out.autostart = r.autostart;
  if (typeof r.alwaysOnTop === 'boolean') out.alwaysOnTop = r.alwaysOnTop;
  if (typeof r.displayId === 'number' && Number.isFinite(r.displayId)) out.displayId = r.displayId;
  if (typeof r.batterySaver === 'boolean') out.batterySaver = r.batterySaver;
  if (typeof r.petName === 'string' && r.petName.trim()) out.petName = r.petName.trim().slice(0, 12);
  if (r.personality === 'gentle' || r.personality === 'lively' || r.personality === 'aloof') {
    out.personality = r.personality;
  }
  if (typeof r.bubblesEnabled === 'boolean') out.bubblesEnabled = r.bubblesEnabled;
  if (typeof r.randomChatter === 'boolean') out.randomChatter = r.randomChatter;
  if (typeof r.naturalEnabled === 'boolean') out.naturalEnabled = r.naturalEnabled;
  if (r.naturalFrequency === 'low' || r.naturalFrequency === 'normal' || r.naturalFrequency === 'high') {
    out.naturalFrequency = r.naturalFrequency;
  }
  return out;
}

export interface ConfigLoadResult {
  data: PetConfig;
  source: 'file' | 'backup' | 'default';
  recovered: boolean;
  error?: string;
}

function readConfig(file: string): PetConfig {
  return coerceConfig(JSON.parse(readFileSync(file, 'utf8')));
}

function preserveCorrupt(file: string): void {
  try {
    if (!existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(file, `${file}.${stamp}.corrupt`);
  } catch {
    // Recovery must still proceed if the broken file is locked. Never delete it.
  }
}

/** Load main -> backup -> defaults, preserving malformed input for diagnosis. */
export function loadConfigFile(file: string): ConfigLoadResult {
  let error = '';
  if (existsSync(file)) {
    try {
      return { data: readConfig(file), source: 'file', recovered: false };
    } catch (err) {
      error = String(err);
    }
  }

  const backup = `${file}.bak`;
  if (existsSync(backup)) {
    try {
      const data = readConfig(backup);
      if (error) preserveCorrupt(file);
      return { data, source: 'backup', recovered: true, error: error || undefined };
    } catch (err) {
      error = `${error}; backup: ${String(err)}`;
    }
  }

  if (error) preserveCorrupt(file);
  return {
    data: { ...DEFAULT_CONFIG },
    source: 'default',
    recovered: Boolean(error),
    error: error || undefined,
  };
}

/** Debounced caller supplies the file; this function provides the atomic write. */
export function saveConfigFile(file: string, data: PetConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const clean = coerceConfig(data);
  writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  renameSync(tmp, file);
  // A known-good copy lets the next launch recover from truncation or external
  // editor damage. It is small, local and written only after the atomic rename.
  copyFileSync(file, `${file}.bak`);
}
