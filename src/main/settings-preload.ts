import { contextBridge, ipcRenderer } from 'electron';
import type { PetConfig } from './config';

export interface DisplayOption {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface PluginOption {
  name: string;
  hasManifest: boolean;
}

export interface SettingsState {
  config: PetConfig;
  version: string;
  hidden: boolean;
  displays: DisplayOption[];
  plugins: PluginOption[];
}

export interface SettingsBridge {
  getState(): Promise<SettingsState>;
  patch(part: Partial<PetConfig>): Promise<PetConfig>;
  close(): void;
  toggleHidden(): void;
  openPlugins(): Promise<string>;
  openRepository(): Promise<void>;
  previewNatural(key: string): Promise<void>;
  onState(cb: (state: SettingsState) => void): void;
}

const bridge: SettingsBridge = {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  patch: (part) => ipcRenderer.invoke('settings:update', part),
  close: () => ipcRenderer.send('settings:close'),
  toggleHidden: () => ipcRenderer.send('settings:toggle-hidden'),
  openPlugins: () => ipcRenderer.invoke('settings:open-plugins'),
  openRepository: () => ipcRenderer.invoke('settings:open-repository'),
  previewNatural: (key) => ipcRenderer.invoke('settings:preview-natural', key),
  onState: (cb) => ipcRenderer.on('settings:state', (_e, state) => cb(state)),
};

contextBridge.exposeInMainWorld('settings', bridge);
