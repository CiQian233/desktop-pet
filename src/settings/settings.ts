import type { PetConfig } from '../renderer/config-types';

interface DisplayOption {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}
interface PluginOption { name: string; hasManifest: boolean }
interface SettingsState {
  config: PetConfig;
  version: string;
  hidden: boolean;
  displays: DisplayOption[];
  plugins: PluginOption[];
}
interface SettingsBridge {
  getState(): Promise<SettingsState>;
  patch(part: Partial<PetConfig>): Promise<PetConfig>;
  close(): void;
  toggleHidden(): void;
  openPlugins(): Promise<string>;
  openRepository(): Promise<void>;
  previewNatural(key: string): Promise<void>;
  onState(cb: (state: SettingsState) => void): void;
}
declare global { interface Window { settings: SettingsBridge } }

const PAGE_COPY: Record<string, [string, string]> = {
  behavior: ['行为', '安排猫咪的日常活动与互动方式'],
  sound: ['声音', '集中管理声音能力'],
  dnd: ['免打扰', '控制主动出现的信息与桌宠可见性'],
  performance: ['性能', '在流畅动画与电量消耗之间选择'],
  plugins: ['插件', '查看本地插件目录与宿主状态'],
  appearance: ['外观', '调整像素倍率、显示器与窗口层级'],
  about: ['关于', '版本信息与项目地址'],
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing settings element: ${id}`);
  return node as T;
}

let displaySignature = '';

function render(state: SettingsState): void {
  el('sidebar-version').textContent = `v${state.version}`;
  el('about-version').textContent = `版本 ${state.version}`;
  el<HTMLSelectElement>('setting-mode').value = state.config.mode;
  el<HTMLSelectElement>('setting-speed').value = state.config.roamSpeed;
  el<HTMLInputElement>('setting-paused').checked = state.config.paused;
  el<HTMLInputElement>('setting-autostart').checked = state.config.autostart;
  el<HTMLInputElement>('setting-name').value = state.config.petName;
  el<HTMLSelectElement>('setting-personality').value = state.config.personality;
  el<HTMLInputElement>('setting-bubbles').checked = state.config.bubblesEnabled;
  el<HTMLInputElement>('setting-chatter').checked = state.config.randomChatter;
  el<HTMLInputElement>('setting-chatter').disabled = !state.config.bubblesEnabled;
  el<HTMLInputElement>('setting-natural').checked = state.config.naturalEnabled;
  el<HTMLSelectElement>('setting-natural-frequency').value = state.config.naturalFrequency;
  el<HTMLSelectElement>('setting-natural-frequency').disabled = !state.config.naturalEnabled;
  el<HTMLInputElement>('setting-battery').checked = state.config.batterySaver;
  el<HTMLSelectElement>('setting-scale').value = String(state.config.scale);
  el<HTMLInputElement>('setting-top').checked = state.config.alwaysOnTop;
  el<HTMLButtonElement>('toggle-hidden').textContent = state.hidden ? '显示桌宠' : '隐藏桌宠';

  const nextSignature = JSON.stringify(state.displays.map((d) => [d.id, d.width, d.height, d.primary]));
  const display = el<HTMLSelectElement>('setting-display');
  if (nextSignature !== displaySignature) {
    displaySignature = nextSignature;
    display.replaceChildren();
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '自动（当前活动屏）';
    display.append(auto);
    state.displays.forEach((item, index) => {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = `显示器 ${index + 1}${item.primary ? '（主）' : ''} · ${item.width}×${item.height}`;
      display.append(option);
    });
  }
  display.value = state.config.displayId == null ? 'auto' : String(state.config.displayId);

  const plugins = el('plugin-list');
  plugins.replaceChildren();
  if (state.plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-row';
    empty.textContent = '目录中还没有插件';
    plugins.append(empty);
  }
  for (const plugin of state.plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const name = document.createElement('span');
    name.textContent = plugin.name;
    const status = document.createElement('small');
    status.textContent = plugin.hasManifest ? '发现 manifest · 未加载' : '普通文件夹 · 未加载';
    row.append(name, status);
    plugins.append(row);
  }
}

async function update(part: Partial<PetConfig>): Promise<void> {
  el('settings-status').textContent = '正在应用…';
  try {
    await window.settings.patch(part);
    el('settings-status').textContent = '设置已应用并保存';
  } catch (err) {
    el('settings-status').textContent = `设置失败：${String(err)}`;
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    const key = tab.dataset.tab ?? 'behavior';
    document.querySelectorAll('[data-tab]').forEach((node) => node.classList.toggle('active', node === tab));
    document.querySelectorAll('[data-page]').forEach((node) => node.classList.toggle('active', (node as HTMLElement).dataset.page === key));
    const copy = PAGE_COPY[key] ?? PAGE_COPY.behavior;
    el('page-title').textContent = copy[0];
    el('page-subtitle').textContent = copy[1];
  });
}

el<HTMLSelectElement>('setting-mode').addEventListener('change', (event) => {
  void update({ mode: (event.target as HTMLSelectElement).value as PetConfig['mode'] });
});
el<HTMLSelectElement>('setting-speed').addEventListener('change', (event) => {
  void update({ roamSpeed: (event.target as HTMLSelectElement).value as PetConfig['roamSpeed'] });
});
el('setting-paused').addEventListener('change', (event) => void update({ paused: (event.target as HTMLInputElement).checked }));
el('setting-autostart').addEventListener('change', (event) => void update({ autostart: (event.target as HTMLInputElement).checked }));
el('setting-name').addEventListener('change', (event) => {
  void update({ petName: (event.target as HTMLInputElement).value });
});
el<HTMLSelectElement>('setting-personality').addEventListener('change', (event) => {
  void update({ personality: (event.target as HTMLSelectElement).value as PetConfig['personality'] });
});
el('setting-bubbles').addEventListener('change', (event) => void update({ bubblesEnabled: (event.target as HTMLInputElement).checked }));
el('setting-chatter').addEventListener('change', (event) => void update({ randomChatter: (event.target as HTMLInputElement).checked }));
el('setting-natural').addEventListener('change', (event) => void update({ naturalEnabled: (event.target as HTMLInputElement).checked }));
el<HTMLSelectElement>('setting-natural-frequency').addEventListener('change', (event) => {
  void update({ naturalFrequency: (event.target as HTMLSelectElement).value as PetConfig['naturalFrequency'] });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-natural-preview]')) {
  button.addEventListener('click', () => {
    void (async () => {
      const key = button.dataset.naturalPreview ?? '';
      const label = button.textContent ?? key;
      button.disabled = true;
      el('settings-status').textContent = `正在请求预览${label}…`;
      try {
        await window.settings.previewNatural(key);
        el('settings-status').textContent = `已发送${label}预览；若桌宠已暂停，会自动恢复`;
      } catch (err) {
        el('settings-status').textContent = `预览失败：${String(err)}`;
      } finally {
        button.disabled = false;
      }
    })();
  });
}
el('setting-battery').addEventListener('change', (event) => void update({ batterySaver: (event.target as HTMLInputElement).checked }));
el<HTMLSelectElement>('setting-scale').addEventListener('change', (event) => {
  void update({ scale: Number((event.target as HTMLSelectElement).value) as PetConfig['scale'] });
});
el<HTMLSelectElement>('setting-display').addEventListener('change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  void update(value === 'auto' ? { displayId: null } : { displayId: Number(value), x: null, y: null });
});
el('setting-top').addEventListener('change', (event) => void update({ alwaysOnTop: (event.target as HTMLInputElement).checked }));
el('close-settings').addEventListener('click', () => window.settings.close());
el('toggle-hidden').addEventListener('click', () => window.settings.toggleHidden());
el('open-plugins').addEventListener('click', () => {
  void window.settings.openPlugins().then((error) => {
    el('settings-status').textContent = error || '已打开插件目录';
  });
});
el('open-repository').addEventListener('click', () => void window.settings.openRepository());
window.settings.onState(render);
void window.settings.getState().then(render).catch((err: unknown) => {
  el('settings-status').textContent = `无法读取设置：${String(err)}`;
});
