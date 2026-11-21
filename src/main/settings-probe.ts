import { app, type BrowserWindow } from 'electron';

import type { ConfigStore } from './config';

interface SettingsProbeContext {
  openSettingsWindow(): BrowserWindow;
  store: ConfigStore;
  autostartMatches(enabled: boolean): boolean;
  applyAutostart(enabled: boolean): void;
}

/** Settings UI, real IPC, persistence feedback and isolated autostart readback. */
export async function runSettingsProbe(context: SettingsProbeContext): Promise<Record<string, unknown>> {
  const { openSettingsWindow, store, autostartMatches, applyAutostart } = context;
  const settings = openSettingsWindow();
  if (settings.webContents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('settings page load timed out')), 8000);
      settings.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  const report = await settings.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const before = await window.settings.getState();
    const tabs = [...document.querySelectorAll('[data-tab]')].map((node) => node.dataset.tab);
    const pages = [...document.querySelectorAll('[data-page]')].map((node) => node.dataset.page);
    document.querySelector('[data-tab="appearance"]').click();
    const select = document.getElementById('setting-scale');
    const wanted = before.config.scale === 4 ? 3 : 4;
    select.value = String(wanted);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(350);
    const changed = await window.settings.getState();
    const visiblePage = document.querySelector('[data-page].active')?.dataset.page ?? '';
    await window.settings.patch({ scale: before.config.scale });
    const restored = await window.settings.getState();
    return {
      tabs, pages, visiblePage, version: before.version,
      beforeScale: before.config.scale,
      changedScale: changed.config.scale,
      restoredScale: restored.config.scale,
      displayOptions: document.getElementById('setting-display').options.length,
      successStatus: document.getElementById('settings-status').textContent,
    };
  })()`, true) as {
    tabs: string[]; pages: string[]; visiblePage: string; version: string;
    beforeScale: number; changedScale: number; restoredScale: number; displayOptions: number; successStatus: string;
  };

  process.env.PET_TEST_SAVE_FAILURE = '1';
  const saveFailure = await settings.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('setting-name');
    input.value = '保存失败负例';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    const status = document.getElementById('settings-status').textContent;
    return { error: status.includes('设置失败') ? status : '', status };
  })()`, true) as { error: string; status: string };
  delete process.env.PET_TEST_SAVE_FAILURE;
  const saveFailureReported = saveFailure.error.includes('保存失败') &&
    saveFailure.status.includes('保存失败') && !saveFailure.status.includes('已应用并保存');

  const targetAutostart = !store.all().autostart;
  const autostartSuccess = await settings.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('setting-autostart');
    input.checked = ${targetAutostart};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    const status = document.getElementById('settings-status').textContent;
    return { error: status.includes('设置失败') ? status : '', status };
  })()`, true) as { error: string; status: string };
  const autostartVerified = !autostartSuccess.error && autostartMatches(targetAutostart) &&
    autostartSuccess.status.includes('已应用并保存');

  process.env.PET_TEST_AUTOSTART_FAILURE = '1';
  const autostartFailure = await settings.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('setting-autostart');
    input.checked = ${!targetAutostart};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    const status = document.getElementById('settings-status').textContent;
    return { error: status.includes('设置失败') ? status : '', status };
  })()`, true) as { error: string; status: string };
  delete process.env.PET_TEST_AUTOSTART_FAILURE;
  applyAutostart(store.all().autostart);
  const autostartFailureReported = autostartFailure.error.includes('开机自启未生效') &&
    autostartFailure.status.includes('开机自启未生效') && !autostartFailure.status.includes('已应用并保存');

  settings.close();
  const expectedTabs = ['behavior', 'sound', 'dnd', 'performance', 'plugins', 'appearance', 'about'];
  const ok = expectedTabs.every((key) => report.tabs.includes(key) && report.pages.includes(key)) &&
    report.visiblePage === 'appearance' && report.changedScale !== report.beforeScale &&
    report.restoredScale === report.beforeScale && report.displayOptions >= 2 && report.version === app.getVersion() &&
    report.successStatus.includes('已应用并保存') && saveFailureReported && autostartVerified && autostartFailureReported;
  return { settingsCheck: { ...report, saveFailureReported, autostartVerified, autostartFailureReported,
    saveFailure, autostartSuccess, autostartFailure, ok } };
}
