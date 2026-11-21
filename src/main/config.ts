import { app } from 'electron';
import { join } from 'node:path';

import {
  coerceConfig,
  DEFAULT_CONFIG,
  loadConfigFile,
  saveConfigFile,
  type PetConfig,
} from './config-core';

export type { PetConfig, PetMode, PetScale, RoamSpeed, PetPersonality, NaturalFrequency } from './config-core';

function configPath(): string {
  return join(app.getPath('userData'), 'pet-config.json');
}

export class ConfigStore {
  private data: PetConfig = { ...DEFAULT_CONFIG };
  private saveTimer: NodeJS.Timeout | null = null;
  private readOnly = false;

  /** smoke runs must never touch the user's real config file */
  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  load(): PetConfig {
    const file = configPath();
    const result = loadConfigFile(file);
    this.data = result.data;
    if (result.error) console.error('[config] read/recovery notice:', result.error);
    if (result.source === 'file') console.log(`[config] loaded ${file}`, JSON.stringify(this.data));
    else if (result.source === 'backup') console.warn(`[config] recovered from ${file}.bak`, JSON.stringify(this.data));
    else console.log(`[config] using defaults at ${file}`, JSON.stringify(this.data));
    return this.data;
  }

  all(): PetConfig {
    return this.data;
  }

  /** merge a partial update and schedule a debounced write */
  patch(part: Partial<PetConfig>): PetConfig {
    this.data = coerceConfig({ ...this.data, ...part });
    this.scheduleSave();
    return this.data;
  }

  /** Reset without writing, used by isolated smoke cases. */
  reset(part: Partial<PetConfig> = {}): PetConfig {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.data = coerceConfig({ ...DEFAULT_CONFIG, ...part });
    return this.data;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): { ok: boolean; error?: string; readOnly?: boolean } {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Test-only fault injection. Keep it ahead of readOnly so isolated settings
    // runs can verify the visible failure path without touching a real file.
    if (process.env.PET_SMOKE_MS && process.env.PET_TEST_SAVE_FAILURE === '1') {
      return { ok: false, error: 'injected configuration save failure' };
    }
    if (this.readOnly) return { ok: true, readOnly: true };
    try {
      saveConfigFile(configPath(), this.data);
      return { ok: true };
    } catch (err) {
      console.error('[config] save failed:', err);
      return { ok: false, error: String(err) };
    }
  }
}
